use anyhow::Result;
use imp_exec_api::{
    CacheOutcome, ExecAction, ExecIoSpec, ExecOutcome, ExecToolSpec, SandboxRetention,
};

use crate::proto;

fn cache_outcome_to_proto(outcome: CacheOutcome) -> u32 {
    match outcome {
        CacheOutcome::Fresh => 0,
        CacheOutcome::FreshPushed => 1,
        CacheOutcome::HitLocal => 2,
        CacheOutcome::HitRemote => 3,
    }
}

fn cache_outcome_from_proto(value: u32) -> CacheOutcome {
    match value {
        1 => CacheOutcome::FreshPushed,
        2 => CacheOutcome::HitLocal,
        3 => CacheOutcome::HitRemote,
        _ => CacheOutcome::Fresh,
    }
}

pub fn action_to_proto(action: ExecAction) -> proto::ExecAction {
    proto::ExecAction {
        argv: action.argv,
        display: action.display,
        env: action.env.into_iter().collect(),
        config_digest: action.config_digest,
        input_digest: action.input_digest,
        outputs: action
            .outputs
            .into_iter()
            .map(|o| proto::ExecOutput {
                path: o.path.unwrap_or_default(),
                kind: o.kind,
                named_cache_name: o
                    .named_cache
                    .as_ref()
                    .map(|x| x.name.clone())
                    .unwrap_or_default(),
                named_cache_key: o
                    .named_cache
                    .as_ref()
                    .map(|x| x.key.clone())
                    .unwrap_or_default(),
                named_cache_shared: o.named_cache.as_ref().map(|x| x.shared).unwrap_or_default(),
            })
            .collect(),
        tools: action
            .tools
            .into_iter()
            .map(|t| proto::ExecTool {
                name: t.name,
                cache: t.cache,
                key: t.key,
                path: t.path.to_string_lossy().into_owned(),
                bin_dirs: t.bin_dirs,
            })
            .collect(),
        impure: action.impure,
        force_cache: action.force_cache,
        no_cache: action.no_cache,
        sandbox_retention: action.sandbox_retention.as_u8() as u32,
        allow_failure: action.allow_failure,
    }
}

pub fn action_from_proto(p: proto::ExecAction) -> Result<ExecAction> {
    Ok(ExecAction {
        argv: p.argv,
        display: p.display,
        env: p.env.into_iter().collect(),
        config_digest: p.config_digest,
        input_digest: p.input_digest,
        outputs: p
            .outputs
            .into_iter()
            .map(|o| ExecIoSpec {
                path: Some(o.path),
                kind: o.kind,
                digest: None,
                named_cache: if o.named_cache_name.is_empty() {
                    None
                } else {
                    Some(imp_store::cache::OutputNamedCache {
                        name: o.named_cache_name,
                        key: o.named_cache_key,
                        shared: o.named_cache_shared,
                    })
                },
            })
            .collect(),
        tools: p
            .tools
            .into_iter()
            .map(|t| ExecToolSpec {
                name: t.name,
                cache: t.cache,
                key: t.key,
                path: t.path.into(),
                bin_dirs: t.bin_dirs,
            })
            .collect(),
        impure: p.impure,
        force_cache: p.force_cache,
        no_cache: p.no_cache,
        sandbox_retention: SandboxRetention::from_u8(p.sandbox_retention as u8),
        allow_failure: p.allow_failure,
    })
}

pub fn outcome_to_proto(outcome: ExecOutcome) -> proto::Outcome {
    proto::Outcome {
        exit_code: outcome.exit_code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        output_digest: outcome.output_digest,
        outputs: outcome
            .outputs
            .into_iter()
            .map(|o| proto::CachedArtifact {
                artifact_id: o.artifact_id,
                kind: o.kind,
                path: o.path.unwrap_or_default(),
                digest: o.digest,
                bytes: o.bytes.unwrap_or_default(),
                mode: o.mode.unwrap_or_default(),
                tree_digest: o.tree_digest.unwrap_or_default(),
                named_cache_name: o
                    .named_cache
                    .as_ref()
                    .map(|x| x.name.clone())
                    .unwrap_or_default(),
                named_cache_key: o
                    .named_cache
                    .as_ref()
                    .map(|x| x.key.clone())
                    .unwrap_or_default(),
                named_cache_shared: o.named_cache.as_ref().map(|x| x.shared).unwrap_or_default(),
            })
            .collect(),
        cache_outcome: cache_outcome_to_proto(outcome.cache_outcome),
    }
}

pub fn outcome_from_proto(o: proto::Outcome) -> ExecOutcome {
    ExecOutcome {
        stdout: o.stdout,
        stderr: o.stderr,
        exit_code: o.exit_code,
        output_digest: o.output_digest,
        cache_outcome: cache_outcome_from_proto(o.cache_outcome),
        outputs: o
            .outputs
            .into_iter()
            .map(|x| imp_store::cache::CachedArtifact {
                artifact_id: x.artifact_id,
                kind: x.kind,
                path: if x.path.is_empty() {
                    None
                } else {
                    Some(x.path)
                },
                value: None,
                digest: x.digest,
                bytes: if x.bytes == 0 { None } else { Some(x.bytes) },
                mode: if x.mode == 0 { None } else { Some(x.mode) },
                tree_digest: if x.tree_digest.is_empty() {
                    None
                } else {
                    Some(x.tree_digest)
                },
                named_cache: if x.named_cache_name.is_empty() {
                    None
                } else {
                    Some(imp_store::cache::OutputNamedCache {
                        name: x.named_cache_name,
                        key: x.named_cache_key,
                        shared: x.named_cache_shared,
                    })
                },
            })
            .collect(),
    }
}
