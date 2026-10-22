//! A bounded set of scenario Cities backed by shared immutable street data.
//! Scenario selectors never mutate a City's timetable, access profile or traffic.
use super::{City, Result, fail};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    time::Instant,
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
    timetable_budget: usize,
    resident_heap_budget: usize,
    last_query_timing: Value,
    load_ms: f64,
    eviction_ms: f64,
}
impl Runtime {
    pub(crate) fn install_realtime(&mut self, message: &mut Value) -> Result<()> {
        let Self::Single(city) = self else {
            return fail("GTFS-RT polling requires a single City");
        };
        city.install_realtime(message)
    }
    pub(crate) fn install_traffic(&mut self, value: &Value) -> Result<()> {
        let Self::Single(city) = self else {
            return fail("Automatic NDW polling requires a single City");
        };
        city.load_drive()?;
        let drive = city.drive.as_mut().unwrap();
        let snapshot = if value.is_null() {
            None
        } else {
            let fingerprint = drive.image.header["identity"]["sourceFingerprint"]
                .as_str()
                .ok_or("Missing street fingerprint")?;
            Some(drive.kernel.compile_traffic(value, fingerprint)?)
        };
        drive.automatic_traffic = snapshot;
        city.polling_enabled = true;
        Ok(())
    }

    /// `store` selects one routing store of a Studio project.
    pub(crate) fn open_store(path: &str, store: Option<&str>) -> Result<Self> {
        let root = fs::canonicalize(path)?;
        // A Studio project's `scenarios.json` is its scenario library, not a collection.
        if super::project::is_project(&root) {
            return Ok(Self::Single(Box::new(City::open_project(
                root,
                store.map(Path::new),
            )?)));
        }
        if store.is_some() {
            return fail("--routing-store applies to a Studio project");
        }
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
            timetable_budget: super::timetable_cache::TimetableCache::from_env()?.budget,
            last_query_timing: Value::Null,
            load_ms: 0.,
            eviction_ms: 0.,
            resident_heap_budget: match std::env::var("VIGO_RESIDENT_HEAP_BYTES") {
                Ok(v) => v
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or("VIGO_RESIDENT_HEAP_BYTES must be a positive integer")?,
                Err(std::env::VarError::NotPresent) => {
                    crate::resources::cache_budget(1024 * 1024 * 1024, 3)
                }
                Err(e) => return Err(e.into()),
            },
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
                let selection_started = Instant::now();
                c.select(&id)?;
                let selection_ms = selection_started.elapsed().as_secs_f64() * 1000.;
                let execution_started = Instant::now();
                let city = &mut c.cities.back_mut().unwrap().1;
                city.query_workspace = c.query_workspace.take();
                let result = if detailed {
                    city.execute_detailed(kind, &query)
                } else {
                    city.execute_public(kind, &query)
                };
                let execution_ms = execution_started.elapsed().as_secs_f64() * 1000.;
                let retention_started = Instant::now();
                c.query_workspace = city.take_query_workspace();
                if let Some(timetable) = &mut city.timetable
                    && timetable
                        .kernel
                        .share_source_columns(&mut c.timetable_blocks)
                {
                    c.timetable_blocks.prune();
                    super::release_preparation_memory();
                }
                c.enforce_resident_budget();
                c.last_query_timing = json!({"scenarioId":id,"selectionMs":selection_ms,
                    "cityOpenMs":c.load_ms,"executionMs":execution_ms,
                    "retentionMs":retention_started.elapsed().as_secs_f64()*1000.,
                    "evictionMs":c.eviction_ms});
                let mut result = result?;
                result["scenarioId"] = json!(id);
                Ok(result)
            }
        }
    }
}
impl Collection {
    fn resident_heap_bytes(&self) -> usize {
        let mut streets = HashSet::new();
        let mut bytes = self.timetable_blocks.unique_bytes()
            + self.timetable_blocks.index_bytes()
            + self
                .query_workspace
                .as_ref()
                .map_or(0, crate::timetable::TimetableQueryWorkspace::byte_length);
        for (_, city) in &self.cities {
            let ledger = city.memory_ledger();
            let n = |value: &Value, key: &str| value[key].as_u64().unwrap_or(0) as usize;
            let street = &ledger["street"];
            if streets.insert(&city.street_directory) {
                bytes += n(street, "sharedHeapBytes");
            }
            for key in ["accessHeapBytes", "workspaceHeapBytes", "cacheHeapBytes"] {
                bytes += n(street, key);
            }
            for key in [
                "cityDictionaryHeapBytes",
                "timetableSourceOwnedHeapBytes",
                "timetableIndexHeapBytes",
                "timetableWorkspaceHeapBytes",
                "cityCacheHeapBytes",
                "sqliteHeapBytes",
            ] {
                bytes += n(&ledger, key);
            }
            if let Some(drive) = ledger.get("drive") {
                for key in ["networkHeapBytes", "trafficHeapBytes", "workspaceHeapBytes"] {
                    bytes += n(drive, key);
                }
            }
        }
        bytes
    }
    fn enforce_resident_budget(&mut self) {
        let started = Instant::now();
        let mut released = false;
        while self.cities.len() > 1 && self.resident_heap_bytes() > self.resident_heap_budget {
            // Optional source/kernel caches are cheaper to rebuild than a City.
            // Keep active timetables and street preparation until caches are empty.
            if !self
                .cities
                .iter_mut()
                .any(|(_, city)| city.timetable_cache.evict_oldest())
            {
                self.cities.pop_front();
                self.evictions += 1;
            }
            self.timetable_blocks.prune();
            released = true;
        }
        if released {
            super::release_preparation_memory();
            self.eviction_ms += started.elapsed().as_secs_f64() * 1000.;
        }
    }
    fn select(&mut self, id: &str) -> Result<&mut City> {
        self.load_ms = 0.;
        self.eviction_ms = 0.;
        if let Some(index) = self.cities.iter().position(|(key, _)| key == id) {
            let mut city = self.cities.remove(index).unwrap();
            if let Some((_, previous)) = self.cities.back_mut() {
                city.1.street.reuse_street_scratch(&mut previous.street);
            }
            self.cities.push_back(city);
        } else {
            self.enforce_resident_budget();
            let path = &self
                .manifest
                .scenarios
                .iter()
                .find(|s| s.id == id)
                .ok_or_else(|| format!("Unknown scenarioId: {id}"))?
                .city;
            // Reserve an estimated resident view before opening its replacement.
            // The estimate includes a share of common data and is conservative
            // for similar scenarios; the post-query check uses actual ownership.
            let reservation = self.resident_heap_bytes() / self.cities.len().max(1);
            let mut retired_street = None;
            while self.cities.len() >= self.manifest.maximum_resident_scenarios
                || (!self.cities.is_empty()
                    && self.resident_heap_bytes().saturating_add(reservation)
                        > self.resident_heap_budget)
            {
                let eviction_started = Instant::now();
                let (_, mut city) = self.cities.pop_front().unwrap();
                // Drop the evicted timetable, stop data and caches before
                // opening its replacement, retaining only reusable streets.
                let mut streets = city.street.share_streets()?;
                streets.reuse_street_scratch(&mut city.street);
                retired_street = Some((city.street_directory.clone(), streets));
                self.evictions += 1;
                drop(city);
                self.eviction_ms += eviction_started.elapsed().as_secs_f64() * 1000.;
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
            let load_started = Instant::now();
            let mut city = City::open_shared(Path::new(path), &residents)?;
            self.load_ms = load_started.elapsed().as_secs_f64() * 1000.;
            city.timetable_blocks = None; // The collection owns the shared pool.
            let capacity = self
                .manifest
                .maximum_resident_scenarios
                .min(self.manifest.scenarios.len());
            city.street.partition_cache_budget(capacity);
            city.shape_cache.partition_budget(capacity);
            city.timetable_cache.budget = 0;
            if let Some((_, previous)) = self.cities.back_mut() {
                city.street.reuse_street_scratch(&mut previous.street);
            }
            if let Some((_, previous)) = &mut retired_street {
                city.street.reuse_street_scratch(previous);
            }
            self.cities.push_back((id.to_owned(), city));
            self.opens += 1;
        }
        // Only the selected City can grow its cache on this sequential worker.
        // Other residents keep their charged bytes; unused capacity follows
        // demand instead of being stranded in equal per-scenario partitions.
        let selected = self.cities.len() - 1;
        let mut available = self.timetable_budget;
        for (_, city) in self.cities.iter_mut().take(selected) {
            available = available.saturating_sub(city.timetable_cache.bytes);
            city.timetable_cache.budget = city.timetable_cache.bytes;
        }
        self.cities.back_mut().unwrap().1.timetable_cache.budget = available;
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
            "resourcePolicy":{"memoryCapacityBytes":crate::resources::memory_capacity(),"swapCountsAsRam":false},
            "engineVersion":env!("CARGO_PKG_VERSION"),"defaultScenario":self.manifest.default_scenario,
            "scenarios":self.manifest.scenarios.iter().map(|s| json!({"id":s.id,"name":s.name})).collect::<Vec<_>>(),
            "residency":{"lastQueryTiming":self.last_query_timing,"residentHeapBudgetBytes":self.resident_heap_budget,"residentHeapOverBudget":self.resident_heap_bytes()>self.resident_heap_budget,"maximumScenarios":self.manifest.maximum_resident_scenarios,"loadedScenarios":self.cities.len(),
                "timetableQueryWorkspaces":usize::from(self.query_workspace.is_some()),
                "inactiveTimetableBudgetBytes":self.cities.iter().map(|(_,c)| c.timetable_cache.budget).sum::<usize>(),
                "inactiveTimetableRetainedBytes":self.cities.iter().map(|(_,c)| c.timetable_cache.bytes).sum::<usize>(),
                "timetableSharedBlockBytes":self.timetable_blocks.unique_bytes(),
                "timetableBlockIndexBytes":self.timetable_blocks.index_bytes(),
                "timetableUniqueBlocks":self.timetable_blocks.unique_blocks(),
                "timetableBlockReferences":self.cities.iter().flat_map(|(_, city)| city.timetable.iter().chain(city.timetable_cache.entries())).map(|tt| tt.kernel.source_block_references()).sum::<usize>(),
                "timetableColumnViewBytes":self.cities.iter().flat_map(|(_, city)| city.timetable.iter().chain(city.timetable_cache.entries())).map(|tt| tt.kernel.owned_source_bytes()).sum::<usize>(),
                "timetableWorkspaceBytes":self.query_workspace.as_ref().map_or(0, crate::timetable::TimetableQueryWorkspace::byte_length),
                "sharedStreetGraphs":streets.len(),"cityOpens":self.opens,"evictions":self.evictions,
                "scenarios":self.cities.iter().map(|(id, city)| json!({"id":id,"memory":city.info()["memory"]})).collect::<Vec<_>>()}})
    }
}
