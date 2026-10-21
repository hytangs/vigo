//! Generate the temporary Node ABI from the canonical Rust records. The core
//! crates never compile Node macros; field additions cannot silently drift.
use proc_macro2::TokenStream;
use quote::{format_ident, quote};
use std::{collections::BTreeMap, env, fs, path::Path};
use syn::{GenericArgument, Item, PathArguments, Type};

fn parameter(ty: &Type) -> Option<(&syn::Ident, &Type)> {
    let Type::Path(p) = ty else { return None };
    let last = p.path.segments.last()?;
    let PathArguments::AngleBracketed(args) = &last.arguments else {
        return None;
    };
    match args.args.first()? {
        GenericArgument::Type(t) => Some((&last.ident, t)),
        _ => None,
    }
}
fn name(ty: &Type) -> String {
    match ty {
        Type::Path(p) => p.path.segments.last().unwrap().ident.to_string(),
        _ => String::new(),
    }
}
fn buffer(ty: &Type) -> Option<syn::Ident> {
    match name(ty).as_str() {
        "U32Buffer" => Some(format_ident!("Uint32Array")),
        "U8Buffer" => Some(format_ident!("Uint8Array")),
        "F64Buffer" => Some(format_ident!("Float64Array")),
        _ => None,
    }
}
fn node_type(ty: &Type) -> TokenStream {
    if let Some(t) = buffer(ty) {
        return quote!(#t);
    }
    if let Some((container, inner)) = parameter(ty) {
        let inner = node_type(inner);
        return quote!(#container<#inner>);
    }
    quote!(#ty)
}
fn conversion(
    ty: &Type,
    value: TokenStream,
    inbound: bool,
    records: &BTreeMap<String, (syn::Path, syn::ItemStruct)>,
) -> TokenStream {
    if buffer(ty).is_some() {
        return if inbound {
            quote!(vigo_route::Buffer::from_owner(#value))
        } else {
            quote!((#value).into_vec().into())
        };
    }
    if records.contains_key(&name(ty)) {
        return quote!((#value).into());
    }
    if let Some((container, inner)) = parameter(ty) {
        let child = conversion(inner, quote!(item), inbound, records);
        if child.to_string() == "item" {
            return value;
        }
        if inbound && buffer(inner).is_some() && container == "Option" {
            return quote!((#value).map(vigo_route::Buffer::from_owner));
        }
        return match container.to_string().as_str() {
            "Option" => quote!((#value).map(|item| #child)),
            "Vec" => quote!((#value).into_iter().map(|item| #child).collect()),
            _ => panic!("Unsupported ABI container {container}"),
        };
    }
    value
}
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if env::var_os("CARGO_FEATURE_NODE").is_none() {
        return;
    }
    let root = Path::new("../..");
    let mut sources = vec![(
        "vigo_route::timetable",
        root.join("crates/vigo-route/src/timetable.rs"),
    )];
    let directory = root.join("crates/vigo-route/src/timetable");
    println!("cargo:rerun-if-changed={}", directory.display());
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "rs") {
            sources.push(("vigo_route::timetable", path));
        }
    }
    sources.push((
        "vigo_format",
        root.join("crates/vigo-format/src/timetable.rs"),
    ));
    sources.push((
        "vigo_prepare",
        root.join("crates/vigo-prepare/src/connections.rs"),
    ));
    sources.push((
        "vigo_format",
        root.join("crates/vigo-format/src/snapshot_writer.rs"),
    ));
    let mut records = BTreeMap::new();
    for (module, path) in sources {
        println!("cargo:rerun-if-changed={}", path.display());
        let ast = syn::parse_file(&fs::read_to_string(path).unwrap()).unwrap();
        for item in ast.items {
            if let Item::Struct(item) = item {
                if !item.attrs.iter().any(|attr| attr.path().is_ident("serde")) {
                    continue;
                }
                let name = item.ident.to_string();
                let target: syn::Path = syn::parse_str(&format!("{module}::{name}")).unwrap();
                assert!(
                    records.insert(name, (target, item)).is_none(),
                    "Duplicate ABI record"
                );
            }
        }
    }
    let mut generated = TokenStream::new();
    for (target, item) in records.values() {
        let ident = &item.ident;
        let fields: Vec<_> = item
            .fields
            .iter()
            .map(|f| f.ident.as_ref().expect("Named ABI fields"))
            .collect();
        let types: Vec<_> = item.fields.iter().map(|f| node_type(&f.ty)).collect();
        let incoming: Vec<_> = item
            .fields
            .iter()
            .map(|f| {
                let n = &f.ident;
                conversion(&f.ty, quote!(value.#n), true, &records)
            })
            .collect();
        let outgoing: Vec<_> = item
            .fields
            .iter()
            .map(|f| {
                let n = &f.ident;
                conversion(&f.ty, quote!(value.#n), false, &records)
            })
            .collect();
        // Preserve Clone only where the canonical record requests it.
        let clone = item
            .attrs
            .iter()
            .any(|a| a.path().is_ident("derive") && quote!(#a).to_string().contains("Clone"));
        let derive = if clone {
            quote!(#[derive(Clone)])
        } else {
            quote!()
        };
        generated.extend(quote! {
            #derive
            #[napi(object)]
            pub struct #ident { #(pub #fields: #types,)* }
            impl From<#ident> for #target {
                fn from(value: #ident) -> Self { Self { #(#fields: #incoming,)* } }
            }
            impl From<#target> for #ident {
                fn from(value: #target) -> Self { Self { #(#fields: #outgoing,)* } }
            }
        });
    }
    fs::write(
        Path::new(&env::var_os("OUT_DIR").unwrap()).join("timetable_objects.rs"),
        generated.to_string(),
    )
    .unwrap();
}
