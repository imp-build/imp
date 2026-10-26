# Luau runtime removal coverage

This record is for contributors who review QuickJS removal. It maps removed
Rust runtime tests to retained Luau behavior, authoring-contract exclusions,
or an explicit unresolved contract gap. It does not close the static catalog cleanup or final release audit.

## Command and runtime contract

Imp evaluates only `imp.workspace.luau` and `BUILD.luau`. It ignores
`IMP_RUNTIME`, including old `js` and unknown values. A nearer JavaScript-only
workspace stops discovery with migration instructions. A root with both
workspace files uses Luau.

`imp rules schema` fails during argument parsing with exit code 2. Rules help
omits the command. Bare `imp rules` and `imp config schema` remain available.
There is no replacement target-schema command.

`crates/imp/tests/luau_cutover.rs` checks these boundaries, nested discovery,
per-selector errors, and flags. Program-argument coverage remains in
`run_workflow_starts_one_program_with_the_cli_arguments` and
`run_program_runs_in_the_workspace_with_staged_inputs_and_cli_args` in
`luau.rs`. `run_output.rs` retains its output-order, failure, and signal
assertions with Luau program fixtures.
`empty_quality_goals.rs` retains the Luau warning and unchanged-selection cases.

## Retained test groups

The test names below occur in `crates/imp-engine/src/luau.rs` unless another
source is named. These are behavior replacements. They do not restore the
excluded JavaScript API forms.

| Group | Retained coverage |
| --- | --- |
| Runtime selection | `crates/imp/tests/luau_cutover.rs`; executable-relative rules discovery tests in `loader.rs` |
| Modules and ownership | `workspace_discovers_root_and_nested_build_modules_by_canonical_address`, `resolver_maps_generated_build_names_to_one_canonical_module`, `relative_imports_keep_their_file_backed_namespace`, `resolver_rejects_symlinks_that_escape_their_namespace`, `changed_module_provenance_covers_rules_and_workspace_imports`, and `crates/imp/tests/luau_changed.rs` |
| Configuration | `luau_configuration_schema_and_dynamic_apis_validate_values`, `luau_configuration_errors_name_source_and_field_path`, and `luau_ci_configuration_deep_merges_before_required_validation` |
| Modes | `luau_modes_fork_tasks_outputs_expansions_and_program_inputs`, `luau_modes_scope_persistent_action_cache_to_read_axes`, `luau_modes_resolve_profiles_before_discovery_and_clear_failed_invocations`, and `luau_modes_repository_probe_matches_javascript_fork_and_share_contract` |
| Execution | `luau_task_outputs_flow_through_cas_to_downstream_actions`, `luau_task_options_control_real_action_cache_across_invocations`, `luau_acquired_tool_handles_stage_in_sandbox_and_apply_action_env`, `canceled_luau_actions_stop_through_the_goal_scheduler`, `luau_worker_and_cache_details_use_existing_declared_tools`, and the CLI output tests |
| Expansion | The two retained Luau expansion tests in `spike.rs`; `luau_program_runs_through_expansion_get_and_all`; CMake Luau rule tests |
| BUILD generation | `luau_build_generators_merge_targets_write_and_check_native_build_files`, `luau_build_generator_discovers_unowned_workspace_files`, and `luau_rust_generator_uses_declared_metadata_tasks_and_skips_owned_manifests` |
| Goals and selectors | `generic_goal_driver_passes_resolved_roots_flags_and_args_to_luau`, `selectorless_goal_roots_resolve_before_publication`, `failed_luau_output_producer_does_not_run_its_consumer`, the CLI cutover tests, and the retained pure selector/formatter tests |
| Host and test APIs | `core_reference_declarations_match_live_exports`, `luau_test_roots_discover_cases_and_report_through_test_goal`, `luau_test_fakes_replace_host_functions_and_record_calls`, and the repository Luau rule tests |

## Existing exclusions and replacements

These limits and replacements follow the [Luau authoring contract](luau-authoring-contract.md)
and the [individual host-test outcomes](luau-catalog-cutover-plan.md#host-api-test-triage-outcomes).
They are compatibility limits, not new Luau implementations.

- **Introspection exclusion:** detailed workspace graph introspection remains
  outside the Luau contract. Catalog roots and existing empty diagram walks
  remain; changed-file detection retains its separate Luau dependency walk.
- **Label exclusion:** Luau has no legacy label handles, additive label
  handlers, target address API, or label/target dispatch coexistence.
- **Registry exclusion:** Luau has no legacy target-kind, product-token,
  attribute-schema, product-override selector, or stack-attributed product
  registry. Rule functions and explicit graph handles replace that authoring
  model.
- **Legacy execution exclusion:** JavaScript promises, memo traces, implicit
  run-input tracking, live `run()` calls, and JavaScript worker lanes are
  removed. Legacy plain tool-spec tables are replaced by opaque tool handles.
  Luau tasks and declared actions retain their own tested cache and
  failure behavior. Concurrent actions and concurrent identical-action
  sharing remain assigned to the existing post-cutover tasks.
- **Workspace graph-export gap:** the Luau loader reads workspace return
  values only as configuration and collects selectable roots from BUILD
  modules. The contract's "Module values and graph declarations" section
  nevertheless promises graph-root exports from both workspace and BUILD
  modules. The removed workspace graph-export test has no equivalent for
  that promise. This is a pre-existing implementation/contract gap, pending
  a decision to implement workspace exports or explicitly exclude them.
- **Workspace toolchain replacement:** replace a JavaScript workspace
  toolchain-target export with a registered Luau toolchain, covered by
  `resolve_luau_tool_bin_preserves_arguments_and_exit_status` and the Luau
  CLI tool resolver context test. This replaces tool lookup; it does not
  implement general workspace graph-root exports.
- **Legacy namespace-precedence exclusion:** Luau never substitutes a
  workspace module for an `@imp/rules` module. Use `@workspace/rules/...`
  for vendored workspace modules, or `IMP_RULES_DIR` to select an explicit
  installed rules tree. This replaces the JavaScript `//rules/...` lookup
  that preferred a workspace file over the configured rules tree.
- **Named workflow-facet exclusion:** CLI `@facet` selection remains deferred
  to `2026-10-17-add-luau-named-workflow-facets`. BUILD slots accept one handle,
  not a table of named handles. Expansion-internal facet projection remains
  available; it does not establish CLI named workflow-facet support.
- **Legacy selector helper exclusion:** the removed helpers supported the
  JavaScript graph walk's file-selector fallback. Luau keeps package, exact,
  workflow, and expansion-child selection through its own resolver.

## Removed Rust test inventory

Each row names a removed `spike.rs` test and its group above. Shared glob,
artifact normalization, native-tool single-flight, output-reader, selector,
formatter, and Luau expansion tests remain in `spike.rs`.

| Removed test | Outcome group |
| --- | --- |
| `address_package_of_handles_named_and_default_exports` | Legacy selector helper exclusion |
| `bare_file_selector_only_accepts_a_plain_path_to_a_real_file` | Legacy selector helper exclusion |
| `expansion_children_are_listable_dependency_visible_and_individually_buildable` | Introspection exclusion |
| `discover_expansion_all_false_leaves_expansion_children_undiscovered` | Introspection exclusion |
| `format_graph_diagram_dedupes_shared_producer_and_labels_the_view` | Introspection exclusion |
| `format_graph_diagram_collapses_and_expands_expansion_children` | Introspection exclusion |
| `format_graph_diagram_dot_smoke_test` | Introspection exclusion |
| `format_graph_diagram_hides_plumbing_leaves_unless_show_plumbing_is_set` | Introspection exclusion |
| `resolve_graph_catalog_view_scopes_to_one_workflow` | Introspection exclusion |
| `format_graph_diagram_merges_one_address_multiple_workflows_into_one_box` | Introspection exclusion |
| `stale_graph_addresses_follows_path_dependency_edges` | Goals and selectors |
| `exported_graph_roots_execute_shared_static_tasks_once` | Goals and selectors |
| `graph_task_inputs_start_concurrently` | Legacy execution exclusion |
| `graph_task_inputs_share_one_inflight_producer` | Goals and selectors |
| `graph_expansion_all_children_start_concurrently` | Legacy execution exclusion |
| `graph_task_input_failures_keep_declared_order` | Goals and selectors |
| `graph_goal_handler_receives_named_root_results` | Goals and selectors |
| `workspace_module_can_export_graph_roots` | Workspace graph-export gap |
| `graph_package_path_and_asset_sources_are_build_relative` | Modules and ownership |
| `graph_stamp_file_is_a_shared_cas_artifact` | Goals and selectors |
| `graph_package_path_resolves_correctly_under_a_rules_prefixed_package` | Modules and ownership |
| `graph_package_path_resolves_to_the_consuming_build_js_through_a_helper` | Modules and ownership |
| `graph_package_path_in_imported_build_uses_its_own_module` | Modules and ownership |
| `odin_packages_with_the_same_export_name_keep_independent_source_roots` | Goals and selectors |
| `graph_package_path_survives_top_level_await` | Modules and ownership |
| `graph_build_js_can_import_sibling_child_and_parent_files_by_relative_path` | Modules and ownership |
| `graph_package_path_inside_expand_create_resolves_to_the_declaring_build_js` | Modules and ownership |
| `language_rules_register_the_package_goal_without_the_workflows_layer` | Goals and selectors |
| `graph_relative_import_escaping_the_workspace_root_is_rejected` | Modules and ownership |
| `graph_action_artifacts_compose_without_workspace_materialization` | Execution |
| `graph_action_output_namedcache_lands_in_the_named_cache` | Execution |
| `graph_action_accepts_a_legacy_tool_spec_alongside_a_native_tool` | Legacy execution exclusion |
| `graph_action_mounts_a_named_cache_graph_tool_without_staging_its_tree` | Execution |
| `graph_self_tool_executes_lazily` | Execution |
| `graph_expansion_get_executes_only_the_selected_child` | Goals and selectors |
| `graph_facet_selector_executes_one_named_facet` | Named workflow-facet exclusion |
| `graph_semantic_inputs_resolve_only_at_invocation` | Goals and selectors |
| `configured_rebuilds_only_the_nodes_that_read_the_changed_axis` | Modes |
| `graph_profiles_merge_configuration_and_preserve_named_outputs` | Modes |
| `graph_action_config_salt_is_scoped_and_stable_across_concurrent_branches` | Legacy execution exclusion |
| `configured_collapses_into_the_invocation_when_the_values_agree` | Modes |
| `configured_rejects_an_undeclared_mode_axis` | Modes |
| `memo_recomputation_observes_changed_transitive_inputs` | Legacy execution exclusion |
| `rules_tests_receive_fresh_module_state_per_test` | Modules and ownership |
| `host_js_logs_are_written_through_the_log_crate` | Host and test APIs |
| `workspace_loads_config_before_build_files` | Configuration |
| `workspace_falls_back_to_dev_rules_dir_for_builtin_rules` | Runtime selection |
| `workspace_prefers_on_disk_rules_over_the_dev_fallback` | Legacy namespace-precedence exclusion |
| `workspace_root_is_discovered_from_a_nested_directory` | Runtime selection |
| `workspace_root_accepts_both_runtime_files` | Runtime selection |
| `dual_runtime_workspace_uses_javascript_by_default` | Runtime selection |
| `dual_runtime_workspace_loads_luau_on_request` | Runtime selection |
| `requested_runtime_requires_its_workspace_file` | Runtime selection |
| `runtime_request_rejects_an_unknown_value` | Runtime selection |
| `workspace_root_accepts_a_non_canonicalized_invocation_directory` | Runtime selection |
| `workspace_config_is_available_to_product_functions` | Configuration |
| `build_files_under_gitignored_directories_are_not_discovered` | Modules and ownership |
| `declarative_config_validation_fills_defaults` | Configuration |
| `declarative_config_validation_rejects_unknown_and_wrong_types` | Configuration |
| `declarative_config_validation_rejects_invalid_enum_and_missing_required` | Configuration |
| `declarative_config_validation_accepts_maps_and_checks_values` | Configuration |
| `product_provenance_extracts_rule_modules_from_quickjs_stacks` | Registry exclusion |
| `rule_capabilities_are_derived_from_products_goals_and_declared_tools` | Registry exclusion |
| `product_registration_stack_tracks_the_resolved_source_directory` | Registry exclusion |
| `product_registered_via_a_shared_rules_helper_misattributes_to_the_helper` | Registry exclusion |
| `product_registered_directly_alongside_a_shared_lockfile_helper_attributes_correctly` | Registry exclusion |
| `expand_registers_a_lazily_materialized_dynamic_target` | Expansion |
| `naming_an_expansion_source_target_directly_also_runs_its_minted_children` | Goals and selectors |
| `run_arguments_are_forwarded_to_run_templates` | Execution |
| `new_target_kinds_and_products_need_no_rust_changes` | Registry exclusion |
| `product_run_materializes_named_cache_tools_on_path` | Legacy execution exclusion |
| `memo_reentry_rematerializes_a_missing_named_cache_from_cas` | Legacy execution exclusion |
| `root_relative_imports_can_resolve_build_directory_modules` | Modules and ownership |
| `root_relative_imports_can_resolve_index_js_modules` | Modules and ownership |
| `workspace_file_exports_become_top_level_workspace_targets` | Workspace toolchain replacement |
| `ci_workspace_overlay_is_ignored_outside_github_actions` | Execution |
| `ci_workspace_overlay_extends_the_main_workspace_on_github_actions` | Execution |
| `relative_imports_from_build_files_are_resolved` | Modules and ownership |
| `relative_import_of_an_unknown_module_reports_context` | Modules and ownership |
| `unknown_builtin_modules_are_reported_distinctly` | Modules and ownership |
| `missing_workspace_modules_report_importer_and_candidates` | Modules and ownership |
| `javascript_can_use_platform_info` | Host and test APIs |
| `javascript_can_use_sha256` | Host and test APIs |
| `javascript_can_use_cache_operations` | Host and test APIs |
| `javascript_can_use_extract` | Host and test APIs |
| `quickjs_host_run_promises_can_resolve_with_promise_all` | Legacy execution exclusion |
| `quickjs_host_run_cancels_running_sandbox_child` | Execution |
| `quickjs_host_run_cancel_hands_its_sandbox_to_the_sweep` | Execution |
| `quickjs_host_run_cancel_does_not_wait_for_inherited_output_pipes` | Execution |
| `concurrent_roots_share_an_in_flight_memo_without_a_false_cycle` | Legacy execution exclusion |
| `live_goal_nests_selected_dependencies_under_first_caller` | Legacy execution exclusion |
| `shared_dependency_keeps_post_await_run_ownership_per_caller` | Legacy execution exclusion |
| `promise_all_fanout_restores_parent_context_after_await` | Legacy execution exclusion |
| `sequential_sibling_awaits_do_not_inherit_previous_child_context` | Legacy execution exclusion |
| `live_goal_failure_propagates_instead_of_hanging` | Goals and selectors |
| `live_goal_shared_failing_memo_propagates_to_all_roots` | Legacy execution exclusion |
| `live_goal_starts_selected_roots_concurrently` | Legacy execution exclusion |
| `selected_targets_reflects_cli_selection` | Legacy execution exclusion |
| `selected_targets_errors_outside_goal_execution` | Legacy execution exclusion |
| `selected_targets_cleared_after_goal_execution_completes` | Legacy execution exclusion |
| `goal_callback_rejection_blocks_all_per_target_dispatch` | Goals and selectors |
| `goal_callback_success_skips_native_dispatch` | Goals and selectors |
| `goal_with_no_callback_dispatches_normally` | Goals and selectors |
| `live_goal_js_lane_events_use_configured_worker_slots` | Legacy execution exclusion |
| `live_goal_js_lane_events_do_not_exceed_worker_count` | Legacy execution exclusion |
| `live_goal_single_js_worker_reuses_in_flight_memo_on_inherited_stack` | Legacy execution exclusion |
| `concurrent_roots_keep_run_ownership_after_interleaved_awaits` | Legacy execution exclusion |
| `deferred_run_promises_have_correct_parent_after_interleaved_await` | Legacy execution exclusion |
| `live_goal_no_cache_bypasses_run_task_cache` | Legacy execution exclusion |
| `traced_run_inputs_are_recomputed_across_runtimes` | Legacy execution exclusion |
| `live_config_digest_change_invalidates_run_cache` | Legacy execution exclusion |
| `live_config_digest_ignores_namespaces_the_product_never_read` | Legacy execution exclusion |
| `live_config_digest_never_invalidates_a_product_that_reads_no_configuration` | Legacy execution exclusion |
| `mode_axis_resolves_to_declared_default_when_no_override` | Modes |
| `profile_overlays_one_dependency_without_affecting_its_consumer` | Modes |
| `link_composes_with_profile_to_select_output_and_overlay_mode_axis` | Modes |
| `link_and_profile_compose_regardless_of_nesting_order` | Modes |
| `link_mode_overlay_scopes_the_persistent_action_cache_salt` | Modes |
| `link_rejects_output_select_axis_when_product_has_no_named_output` | Modes |
| `named_outputs_select_ambient_and_linked_values_without_rebuilding` | Modes |
| `link_rejects_rebuild_axis` | Modes |
| `link_rejects_invalid_output_select_axis_value` | Modes |
| `mode_axis_resolves_to_cli_override` | Modes |
| `mode_profile_overlays_declared_axis_defaults` | Modes |
| `mode_profile_carries_namespaced_odin_configuration` | Modes |
| `mode_axis_override_wins_over_selected_profile` | Modes |
| `mode_profile_rejects_unknown_selected_profile` | Modes |
| `mode_profile_rejects_unknown_axis_before_profile_selection` | Modes |
| `mode_profile_rejects_invalid_axis_value` | Modes |
| `mode_axis_does_not_invalidate_a_product_that_does_not_read_it` | Modes |
| `mode_axis_rejects_invalid_value` | Modes |
| `mode_axis_rejects_unknown_axis_name` | Modes |
| `mode_axis_namespace_is_reserved_against_direct_configure` | Modes |
| `product_registration_creates_dispatchable_product_task` | Registry exclusion |
| `product_selector_hash_syntax_is_parsed` | Registry exclusion |
| `selection_requires_selectors_and_wildcards_filter_by_product` | Goals and selectors |
| `changed_selection_runs_selectorless_goal_callback` | Goals and selectors |
| `goal_error_from_a_graph_handler_prints_its_message_alone` | Goals and selectors |
| `plain_error_from_a_graph_handler_keeps_its_diagnostic` | Goals and selectors |
| `goal_error_from_a_task_body_prints_the_report_alone` | Goals and selectors |
| `plain_error_from_a_task_body_keeps_its_diagnostic` | Goals and selectors |
| `product_name_tokens_declare_register_and_select` | Registry exclusion |
| `duplicate_product_name_declaration_across_modules_errors` | Registry exclusion |
| `builtin_product_names_are_redeclaration_protected` | Registry exclusion |
| `forged_product_name_token_is_rejected` | Registry exclusion |
| `goal_returns_token_usable_for_registration` | Registry exclusion |
| `duplicate_kind_classes_are_rejected` | Registry exclusion |
| `source_fields_mark_owned_files_relative_to_declaring_package` | Modules and ownership |
| `workspace_load_records_import_graph_for_changed_detection` | Modules and ownership |
| `generate_build_product_creates_raw_build_files` | BUILD generation |
| `generate_build_runs_all_registered_generate_build_products_by_default` | BUILD generation |
| `generate_build_check_fails_when_files_are_stale` | BUILD generation |
| `generate_build_skips_files_owned_by_existing_targets` | BUILD generation |
| `generate_build_creates_cmake_and_raw_cc_targets` | BUILD generation |
| `generate_build_skips_existing_cmake_owned_cc_files` | BUILD generation |
| `raw_build_renderer_renders_target_refs_as_imports` | BUILD generation |
| `label_dispatches_only_the_selected_goals_handler` | Label exclusion |
| `label_passthrough_env_merges_workspace_and_label_entries` | Label exclusion |
| `label_one_arg_shorthand_creates_and_selects_a_label` | Label exclusion |
| `label_trace_root_never_caches_effectful_handler_execution` | Label exclusion |
| `label_runs_every_additive_handler_attached_to_one_goal` | Label exclusion |
| `label_package_handler_return_artifact_is_materialized_by_the_dispatcher` | Label exclusion |
| `label_package_goal_rejects_more_than_one_artifact_returning_handler` | Label exclusion |
| `label_package_handler_returning_null_publishes_nothing` | Label exclusion |
| `label_attaching_the_same_handler_fn_twice_is_a_hard_error` | Label exclusion |
| `label_addresses_are_stable_across_separate_runtime_creations` | Label exclusion |
| `cmake_project_expand_builds_and_tests_discovered_children` | Expansion |
| `label_and_target_goals_coexist_with_targets_dispatched_first` | Label exclusion |
| `mixed_target_and_label_only_selectors_both_dispatch` | Label exclusion |
| `unmatched_selector_errors_even_when_another_selector_matched_a_graph_root` | Goals and selectors |
| `two_resolving_graph_selectors_both_dispatch` | Goals and selectors |
| `exact_selector_on_wrong_goal_names_the_exported_workflows` | Goals and selectors |
| `wildcard_over_goalless_package_stays_silent` | Goals and selectors |
| `label_one_off_inline_build_and_test_handlers_no_factory` | Label exclusion |
| `callback_goal_skips_empty_target_callback_for_label_only_selection` | Label exclusion |
| `callback_goal_runs_target_callback_before_additive_label_handlers` | Label exclusion |
| `label_only_selector_does_not_trigger_unrelated_target_expanders` | Label exclusion |
| `label_handler_failure_names_the_selected_address_and_goal` | Label exclusion |

The QuickJS loader tests are removed with the loader implementation. Luau
resolver and module tests cover canonical identity, missing imports, namespace
escape, package ownership, and source locations. Executable-relative rules
search tests remain. Pure historical trace path resolution remains available
for reading persisted cache records; it does not evaluate JavaScript.

The JavaScript-only CLI tool-export and worker-lane tests are removed. The
retained Luau tool resolver checks arguments and exit status. The label-only
quality-warning case is excluded with the label API.

## Remaining catalog work

The following task removes obsolete workspace and CI JavaScript modules,
`BUILD.js` declarations, JavaScript rule modules and tests, the old documentation
extractor, and obsolete authoring examples. It refreshes the static migration
inventory. JavaScript and TypeScript application inputs remain supported.

The final cutover task owns the complete cross-workspace release audit and
native-platform evidence. Runtime removal alone does not complete that task.

## Separate implementation gap

The Luau driver already stored the CLI `--no-cache` request in shared state
without passing it to Luau action execution. This removal preserves that
behavior. Per-task `cache = false` remains tested. A separate change must wire
the CLI request through action execution before the CLI can promise a global
cache bypass. The retained `js_workers` compatibility setting does not create
JavaScript worker lanes.

## Verification

Verification ran on Linux against the implementation based on `b4db60b`.
Delivery is recorded in the Peon task receipt. Native macOS and Windows
execution was not run.

The final Imp commands below put the checkout binary first on `PATH` with
`PATH="$PWD/target/debug:$PATH"`. No runtime override or alternate Imp cache
root was set.

| Command or check | Actual result |
| --- | --- |
| `cargo test --workspace --offline` | Exit 0; 402 tests passed across 25 suites, including empty doctest suites. |
| `imp fmt //...` | Exit 0; 26 unchanged, 0 changed, 0 failed. |
| `imp lint //...` | Exit 0; 27 clean, 0 fixed, 0 failed. |
| `imp test //...` | Exit 0; 732/732 units passed. The four failed sandbox actions are expected CMake negative cases. |
| `python3 ci/check_luau_workspace.py --imp target/debug/imp` | Exit 0; 61 BUILD files, 4 exclusions, 90 targets; generation checked 0 files, 0 out of date. |
| `ci/smoke_package.sh <staged-release>` | Exit 0; the staged binary resolved packaged Luau rules outside the checkout and passed generation, builds, nested imports, and tests. |
| `cargo tree --locked --offline` | Exit 0; the resolved graph contains no QuickJS or rquickjs package. |
| In-memory workflow rendering compared with both generated workflow files | Passed; both files match `ci/gen_workflow.py`. |
| `python3 -m unittest discover -s docs -p quality_check_test.py` | Exit 0; 6 tests passed. The full Imp run also passed all 19 docs Python tool tests. |
| `imp lint //docs:quality` | Exit 0; 1 clean, 0 fixed, 0 failed after the contract and coverage record updates. |
| `cargo test -p imp --test empty_quality_goals --test luau_cutover --offline` | Exit 0; 4 warning/changed-selection tests and 3 cutover tests passed. The cutover test also checks that ordinary goals require selectors. |
| `cargo test -p imp --bin imp --offline` | Exit 0; 32 tests passed after the final CLI help wording update. |
| `cargo fmt --all --check` and `git diff --check` | Exit 0. |

Initial implementation runs found and corrected a rules-tree discovery probe
that required a nonexistent root `BUILD.luau`, JavaScript paths in changed-file
fixtures, and a changed-selection diagnostic difference. The final results
above include the corrections. The new selector regression also verifies that
a changed root with no requested workflow remains a successful no-op.

The plain installed launcher was tried first. It selected the obsolete
JavaScript workspace. At that implementation stage, plain formatting passed,
lint reported two affected targets, and tests reported 58/60 units. Those runs
included source defects that were subsequently fixed and legacy JavaScript
coverage that is outside the supported runtime. They are not passing evidence
for the final Luau tree. The checkout-based results above are the final gates.
