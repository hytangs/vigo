//! A bounded set of scenario Cities backed by shared immutable street data.
//! Scenario selectors never mutate a City's timetable, access profile or traffic.
use super::{City, Result, fail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: String,
    name: String,
    default_scenario: String,
    #[serde(default = "default_residents")]
    maximum_resident_scenarios: usize,
    scenarios: Vec<Scenario>,
}
fn default_residents() -> usize {
    2
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Scenario {
    id: String,
    name: String,
    city: PathBuf,
}

pub(crate) enum Runtime {
    Single(Box<City>),
    Collection(Box<Collection>),
}
pub(crate) struct Collection {
    manifest: Manifest,
    // Least-recently used first. At most the configured count is resident,
    // even while opening another City. Graphs are Arc-shared by canonical path.
    cities: VecDeque<(String, City)>,
    opens: usize,
    evictions: usize,
    query_workspace: Option<crate::timetable::TimetableQueryWorkspace>,
    timetable_blocks: crate::timetable::TimetableBlockPool,
}
impl Runtime {
    pub(crate) fn open(path: &str) -> Result<Self> {
        let root = fs::canonicalize(path)?;
        let manifest_path = root.join("scenarios.json");
        if !manifest_path.is_file() {
            return Ok(Self::Single(Box::new(City::open(root)?)));
        }
        let bytes = fs::read(manifest_path)?;
        if bytes.len() > 1024 * 1024 {
            return fail("Scenario manifest exceeds 1 MiB");
        }
        let mut manifest: Manifest = serde_json::from_slice(&bytes)?;
        if manifest.schema_version != "vigo.scenarios.v1"
            || manifest.scenarios.is_empty()
            || manifest.scenarios.len() > 128
        {
            return fail("Expected vigo.scenarios.v1 with 1 to 128 scenarios");
        }
        if let Ok(value) = std::env::var("VIGO_MAX_RESIDENT_SCENARIOS") {
            manifest.maximum_resident_scenarios = value.parse()?;
        }
        if !(1..=16).contains(&manifest.maximum_resident_scenarios) {
            return fail("maximumResidentScenarios must be between 1 and 16");
        }
        let mut ids = HashSet::new();
        for scenario in &mut manifest.scenarios {
            if scenario.id.is_empty()
                || scenario.id.len() > 64
                || !scenario
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                || !ids.insert(scenario.id.clone())
            {
                return fail(
                    "Scenario IDs must be unique and contain only letters, digits, hyphens or underscores",
                );
            }
            if scenario.city.is_absolute() {
                return fail("Scenario City paths must be relative to the collection");
            }
            scenario.city = fs::canonicalize(root.join(&scenario.city))?;
            if !scenario.city.starts_with(&root) {
                return fail("Scenario City must remain inside the collection");
            }
            if !fs::canonicalize(scenario.city.join("osm"))?.starts_with(&root) {
                return fail("Scenario streets must remain inside the collection");
            }
        }
        if !ids.contains(&manifest.default_scenario) {
            return fail("Unknown defaultScenario");
        }
        let default_id = manifest.default_scenario.clone();
        let mut collection = Collection {
            manifest,
            cities: VecDeque::new(),
            opens: 0,
            evictions: 0,
            query_workspace: None,
            timetable_blocks: Default::default(),
        };
        collection.select(&default_id)?;
        Ok(Self::Collection(Box::new(collection)))
    }
    pub(crate) fn info(&self) -> Value {
        match self {
            Self::Single(city) => crate::presentation::format("info", &json!({}), &city.info()),
            Self::Collection(c) => c.info(),
        }
    }
    pub(crate) fn execute_public(&mut self, kind: &str, request: &Value) -> Result<Value> {
        self.execute_output(kind, request, false)
    }
    pub(crate) fn execute_detailed(&mut self, kind: &str, request: &Value) -> Result<Value> {
        self.execute_output(kind, request, true)
    }
    fn execute_output(&mut self, kind: &str, request: &Value, detailed: bool) -> Result<Value> {
        match self {
            Self::Single(city) => {
                if detailed {
                    city.execute_detailed(kind, request)
                } else {
                    city.execute_public(kind, request)
                }
            }
            Self::Collection(c) => {
                if kind == "info" && request.get("scenarioId").is_none() {
                    return Ok(c.info());
                }
                let id = request
                    .get("scenarioId")
                    .map(|v| v.as_str().ok_or("scenarioId must be a string"))
                    .transpose()?
                    .unwrap_or(&c.manifest.default_scenario)
                    .to_owned();
                let mut query = request.clone();
                query
                    .as_object_mut()
                    .ok_or("Request must be an object")?
                    .remove("scenarioId");
                c.select(&id)?;
                let city = &mut c.cities.back_mut().unwrap().1;
                city.query_workspace = c.query_workspace.take();
                let result = if detailed {
                    city.execute_detailed(kind, &query)
                } else {
                    city.execute_public(kind, &query)
                };
                c.query_workspace = city.take_query_workspace();
                if let Some(timetable) = &mut city.timetable
                    && timetable
                        .kernel
                        .share_source_columns(&mut c.timetable_blocks)
                {
                    c.timetable_blocks.prune();
                    super::release_preparation_memory();
                }
                let mut result = result?;
                result["scenarioId"] = json!(id);
                Ok(result)
            }
        }
    }
}
impl Collection {
    fn select(&mut self, id: &str) -> Result<&mut City> {
        if let Some(index) = self.cities.iter().position(|(key, _)| key == id) {
            let mut city = self.cities.remove(index).unwrap();
            if let Some((_, previous)) = self.cities.back_mut() {
                city.1.street.reuse_street_scratch(&mut previous.street);
            }
            self.cities.push_back(city);
        } else {
            let path = &self
                .manifest
                .scenarios
                .iter()
                .find(|s| s.id == id)
                .ok_or_else(|| format!("Unknown scenarioId: {id}"))?
                .city;
            let mut retired_street = None;
            while self.cities.len() >= self.manifest.maximum_resident_scenarios {
                let (_, mut city) = self.cities.pop_front().unwrap();
                // Drop the evicted timetable, stop data and caches before
                // opening its replacement, retaining only reusable streets.
                let mut streets = city.street.share_streets()?;
                streets.reuse_street_scratch(&mut city.street);
                retired_street = Some((city.street_directory, streets));
                self.evictions += 1;
            }
            self.timetable_blocks.prune();
            let residents: Vec<_> = self
                .cities
                .iter()
                .map(|(_, city)| (city.street_directory.as_path(), &city.street))
                .chain(
                    retired_street
                        .iter()
                        .map(|(directory, street)| (directory.as_path(), street)),
                )
                .collect();
            let mut city = City::open_shared(Path::new(path), &residents)?;
            let capacity = self
                .manifest
                .maximum_resident_scenarios
                .min(self.manifest.scenarios.len());
            city.street.partition_cache_budget(capacity);
            city.shape_cache.partition_budget(capacity);
            if let Some((_, previous)) = self.cities.back_mut() {
                city.street.reuse_street_scratch(&mut previous.street);
            }
            if let Some((_, previous)) = &mut retired_street {
                city.street.reuse_street_scratch(previous);
            }
            self.cities.push_back((id.to_owned(), city));
            self.opens += 1;
        }
        Ok(&mut self.cities.back_mut().unwrap().1)
    }
    fn info(&self) -> Value {
        let streets: HashSet<_> = self
            .cities
            .iter()
            .map(|(_, city)| &city.street_directory)
            .collect();
        let mut shared = HashSet::new();
        let mut network =
            self.timetable_blocks.unique_bytes() + self.timetable_blocks.index_bytes();
        let mut workspaces = self
            .query_workspace
            .as_ref()
            .map_or(0, crate::timetable::TimetableQueryWorkspace::byte_length);
        let (mut caches, mut sqlite, mut mapped) = (0, 0, 0);
        for (_, city) in &self.cities {
            let ledger = city.memory_ledger();
            let n = |v: &Value, key: &str| v[key].as_u64().unwrap_or(0) as usize;
            let street = &ledger["street"];
            if shared.insert(&city.street_directory) {
                network += n(street, "sharedHeapBytes");
                mapped += n(street, "sharedMappedFileBytes");
            }
            network += n(street, "accessHeapBytes")
                + n(&ledger, "cityDictionaryHeapBytes")
                + n(&ledger, "timetableSourceOwnedHeapBytes")
                + n(&ledger, "timetableIndexHeapBytes");
            workspaces +=
                n(street, "workspaceHeapBytes") + n(&ledger, "timetableWorkspaceHeapBytes");
            caches += n(street, "cacheHeapBytes") + n(&ledger, "cityCacheHeapBytes");
            sqlite += n(&ledger, "sqliteHeapBytes");
            mapped += n(street, "accessMappedFileBytes") + n(&ledger, "contextMappedFileBytes");
            if let Some(drive) = ledger.get("drive") {
                network += n(drive, "networkHeapBytes") + n(drive, "trafficHeapBytes");
                workspaces += n(drive, "workspaceHeapBytes");
                mapped += n(drive, "mappedFileBytes");
            }
        }
        let memory = json!({"networkHeapBytes":network,"workspaceHeapBytes":workspaces,"cacheHeapBytes":caches,
            "sqliteHeapBytes":sqlite,"trackedHeapBytes":network+workspaces+caches+sqlite,"mappedFileBytes":mapped,
            "lastOutput":super::memory::output_ledger(),
            "scope":"unique shared street and timetable owners plus all resident scenarios; retained capacity estimates, not RSS; excludes active query temporaries, transport and UI"});
        json!({"schema":"vigo.scenarios.info.v1","status":"ok","name":self.manifest.name,
            "allocator":super::allocator_memory(),"memory":memory,
            "engineVersion":env!("CARGO_PKG_VERSION"),"defaultScenario":self.manifest.default_scenario,
            "scenarios":self.manifest.scenarios.iter().map(|s| json!({"id":s.id,"name":s.name})).collect::<Vec<_>>(),
            "residency":{"maximumScenarios":self.manifest.maximum_resident_scenarios,"loadedScenarios":self.cities.len(),
                "timetableQueryWorkspaces":usize::from(self.query_workspace.is_some()),
                "timetableSharedBlockBytes":self.timetable_blocks.unique_bytes(),
                "timetableBlockIndexBytes":self.timetable_blocks.index_bytes(),
                "timetableUniqueBlocks":self.timetable_blocks.unique_blocks(),
                "timetableBlockReferences":self.cities.iter().filter_map(|(_, city)| city.timetable.as_ref()).map(|tt| tt.kernel.source_block_references()).sum::<usize>(),
                "timetableColumnViewBytes":self.cities.iter().filter_map(|(_, city)| city.timetable.as_ref()).map(|tt| tt.kernel.owned_source_bytes()).sum::<usize>(),
                "timetableWorkspaceBytes":self.query_workspace.as_ref().map_or(0, crate::timetable::TimetableQueryWorkspace::byte_length),
                "sharedStreetGraphs":streets.len(),"cityOpens":self.opens,"evictions":self.evictions,
                "scenarios":self.cities.iter().map(|(id, city)| json!({"id":id,"memory":city.info()["memory"]})).collect::<Vec<_>>()}})
    }
}
