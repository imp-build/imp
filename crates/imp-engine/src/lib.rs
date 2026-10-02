pub mod changed;
pub mod graph;
pub mod loader;
pub mod luau;
pub mod runtime;
pub mod selector;
pub mod spike;
pub mod trace_changed;

#[cfg(test)]
mod environment_tests {
    #[test]
    fn imp_sandbox_test_reuses_imp_cache_and_has_writable_xdg_cache_home() {
        // Host Cargo tests do not have Imp's sandbox contract. The check is
        // only meaningful for a test binary launched by the Imp executor.
        if std::env::var_os("IMP_SANDBOX_ROOT").is_none() {
            return;
        }

        let cache_home =
            std::env::var_os("XDG_CACHE_HOME").expect("Imp test sandboxes must set XDG_CACHE_HOME");
        let cache_home = std::path::PathBuf::from(cache_home);
        let home = std::path::PathBuf::from(
            std::env::var_os("HOME").expect("Imp test sandboxes must set HOME"),
        );
        assert_eq!(cache_home, home.join(".cache"));
        assert!(
            cache_home.is_dir(),
            "XDG_CACHE_HOME is not a directory: {}",
            cache_home.display()
        );

        let probe = cache_home.join(format!(".imp-cache-write-probe-{}", std::process::id()));
        std::fs::write(&probe, b"probe")
            .unwrap_or_else(|error| panic!("XDG_CACHE_HOME is not writable: {error}"));
        std::fs::remove_file(probe).expect("remove XDG cache write probe");

        let shared_cache =
            std::env::var_os("IMP_CACHE_DIR").expect("Imp test sandboxes must share IMP_CACHE_DIR");
        let shared_cache = std::path::PathBuf::from(shared_cache);
        assert!(
            shared_cache.is_dir(),
            "IMP_CACHE_DIR is not a directory: {}",
            shared_cache.display()
        );
        let probe = shared_cache.join(format!(
            ".imp-shared-cache-write-probe-{}",
            std::process::id()
        ));
        std::fs::write(&probe, b"probe")
            .unwrap_or_else(|error| panic!("IMP_CACHE_DIR is not writable: {error}"));
        std::fs::remove_file(probe).expect("remove shared cache write probe");
    }
}
