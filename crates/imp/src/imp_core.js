// Peels an arbitrary nesting of link()/profile() dependency-edge wrappers
// (in either order) down to the plain base Target handle, accumulating each
// wrapper's own metadata along the way. Used everywhere a dep edge is read:
// Target construction, hydrateTarget(), productFor(), memo()'s per-call
// mode-axis overlay, and the digest/serialization helpers below.
function _unwrap_dep_edge(value) {
	let outputOverrides = null;
	let profiles = null;
	let modeOverrides = null;
	while (
		value &&
		typeof value === "object" &&
		(value.__imp_link === true || value.__imp_profile === true)
	) {
		if (value.__imp_link === true) {
			outputOverrides = value.overrides;
		} else {
			profiles = value.profiles;
			modeOverrides = value.overrides;
		}
		value = value.handle;
	}
	return { handle: value, outputOverrides, profiles, modeOverrides };
}

function _serialize_attrs(value) {
	if (value === null || value === undefined || typeof value !== "object")
		return value;
	if (Array.isArray(value)) return value.map(_serialize_attrs);
	if (value.__imp_link === true || value.__imp_profile === true) {
		const { handle, outputOverrides, profiles } = _unwrap_dep_edge(value);
		return {
			__imp_dep_ref: handle.__id,
			overrides:
				outputOverrides === null ? null : _serialize_attrs(outputOverrides),
			profiles,
		};
	}
	if (value.__imp === true) return { __imp_ref: value.__id };
	const out = {};
	for (const [k, v] of Object.entries(value)) out[k] = _serialize_attrs(v);
	return out;
}

function _collect_dependencies(value, out) {
	if (value === null || value === undefined || typeof value !== "object")
		return;
	if (
		value.__imp_link === true ||
		value.__imp_profile === true ||
		value.__imp === true
	) {
		out.push(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const v of value) _collect_dependencies(v, out);
		return;
	}
	for (const v of Object.values(value)) _collect_dependencies(v, out);
}

function _normalize_source_fields(value) {
	if (value === null || value === undefined) return [];
	const values = Array.isArray(value) ? value : [value];
	return values.map((v) => {
		if (!v || v.__imp_source_field !== true) {
			throw new Error(
				"target({ sources }) expects sourcesField(...) or an array of sourcesField(...)",
			);
		}
		return { root: v.root, include: v.include, exclude: v.exclude };
	});
}

/**
 * Declare source files owned by a target.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Root relative to the declaring BUILD package.
 * @param {string[]} opts.include Glob patterns matched relative to root.
 * @param {string[]} [opts.exclude=[]] Glob patterns excluded relative to root.
 * @returns {object} Source ownership descriptor for target({ sources }).
 */
export function sourcesField(opts) {
	if (!opts || !Array.isArray(opts.include)) {
		throw new Error(
			"sourcesField({ root?, include, exclude? }) requires include glob patterns",
		);
	}
	return {
		__imp_source_field: true,
		root: opts.root || ".",
		include: opts.include,
		exclude: opts.exclude || [],
	};
}

/**
 * Base class for all target kinds. Handles host registration, dependency
 * discovery, and address/label resolution. Rule modules define subclasses
 * (e.g. `class OdinPackage extends Target`) that compute a `kind` and
 * `attrs` and pass them to `super(...)`.
 */
export class Target {
	/**
	 * @param {object} opts
	 * @param {string} opts.kind Stable target kind understood by extension rules.
	 * @param {object} [opts.attrs={}] Typed attributes stored on the target. May contain nested
	 *   target handles; those are extracted as dep edges automatically when opts.deps is omitted.
	 * @param {Array<object>} [opts.deps] Explicit dependency list as handles or { target, mode } pairs.
	 *   When omitted, deps are discovered by scanning opts.attrs for target handles.
	 */
	constructor(opts) {
		const depIds = [];
		const depModes = [];
		const depLinks = [];
		const depProfiles = [];
		let attrs =
			opts.attrs !== undefined
				? opts.attrs
				: opts.fields !== undefined
					? opts.fields
					: {};
		const schema = _composed_schema(this.constructor);
		if (schema !== null) {
			attrs = _validate_target_attrs(schema, opts.kind, attrs);
		}
		const sources = _normalize_source_fields(opts.sources);
		if (opts.deps != null) {
			for (const d of opts.deps) {
				if (d && d.target !== undefined) {
					const { handle, outputOverrides, profiles } = _unwrap_dep_edge(
						d.target,
					);
					if (!handle || handle.__imp !== true) {
						throw new Error(
							"dep must be a target handle or { target, mode }, got: " +
								JSON.stringify(d),
						);
					}
					depIds.push(handle.__id);
					depModes.push(d.mode != null ? String(d.mode) : null);
					depLinks.push(outputOverrides);
					depProfiles.push(profiles);
					continue;
				}
				const { handle, outputOverrides, profiles } = _unwrap_dep_edge(d);
				if (!handle || handle.__imp !== true) {
					throw new Error(
						"dep must be a target handle or { target, mode }, got: " +
							JSON.stringify(d),
					);
				}
				depIds.push(handle.__id);
				depModes.push(null);
				depLinks.push(outputOverrides);
				depProfiles.push(profiles);
			}
		} else {
			const found = [];
			_collect_dependencies(attrs, found);
			for (const dep of found) {
				const { handle, outputOverrides, profiles } = _unwrap_dep_edge(dep);
				depIds.push(handle.__id);
				depModes.push(null);
				depLinks.push(outputOverrides);
				depProfiles.push(profiles);
			}
		}
		const id = __host_target(
			opts.kind,
			JSON.stringify(_serialize_attrs(attrs)),
			JSON.stringify(sources),
			depIds,
			depModes,
			depLinks.map((overrides, index) => {
				const profiles = depProfiles[index];
				return overrides === null && profiles === null
					? null
					: JSON.stringify({
							overrides:
								overrides === null ? null : _serialize_attrs(overrides),
							profiles,
						});
			}),
		);

		this.__imp = true;
		this.__id = id;
		this.kind = opts.kind;
		this.attrs = attrs;

		if (globalThis.__imp_handle_by_id)
			globalThis.__imp_handle_by_id.set(id, this);
	}

	get label() {
		const address = targetAddress(this);
		const colon = address.lastIndexOf(":");
		return {
			address,
			name: colon >= 0 ? address.slice(colon + 1) : address,
		};
	}
}

// Keyed by the concrete subclass (not stored as static fields, which
// inheritance would share with the base), so each toolchain kind tracks its
// own default independently.
const _toolchain_defaults = new Map(); // concrete subclass → instance
// Like the product registry, registration survives resetMemoState — the
// TOOLCHAIN product for a kind is registered once per runtime.
const _toolchain_registered = new Set();
// concrete subclass → Map(version → instance), so attrs declared on a
// non-default instance (e.g. `unverified`) resolve correctly even when
// acquiring that version rather than the default one.
const _toolchain_by_version = new Map();

/**
 * Base class for toolchain target kinds. Subclasses declare:
 *
 *   - `static kind` — the target kind, as for any Target subclass;
 *   - `static tool` — the toolchain's declared tool token (see toolName());
 *   - `bin()` — resolve this toolchain instance to an absolute binary path.
 *
 * The base owns the per-kind default instance (`{ default: true }` at
 * construction, read back via `Sub.default()` / `Sub.defaultVersion()` /
 * `Sub.resolveVersion(v)`), replacing the per-module `defaultVersion` /
 * `defaultToolchain` state toolchain modules used to hand-roll. Constructing
 * the first instance of a subclass also registers `product(Sub, TOOLCHAIN,
 * Sub.tool, (handle) => handle.bin())`, which makes every toolchain
 * dispatchable via `imp @<name>` for workspace-exported instances.
 */
export class Toolchain extends Target {
	/**
	 * @param {object} targetOpts Options forwarded to Target: `{ kind, attrs, ... }`.
	 * @param {object} [opts]
	 * @param {boolean} [opts.default=false] Install this instance as the
	 *   subclass's default. Deliberately outside `attrs` so it never enters
	 *   target serialization.
	 */
	constructor(targetOpts, opts = {}) {
		super(targetOpts);
		Toolchain._ensureRegistered(this.constructor);
		if (opts.default) this.constructor.setDefault(this);
		if (targetOpts.attrs?.version !== undefined) {
			let byVersion = _toolchain_by_version.get(this.constructor);
			if (!byVersion) {
				byVersion = new Map();
				_toolchain_by_version.set(this.constructor, byVersion);
			}
			byVersion.set(targetOpts.attrs.version, this);
		}
	}

	static setDefault(instance) {
		_toolchain_defaults.set(this, instance);
	}
	static clearDefault() {
		_toolchain_defaults.delete(this);
		_toolchain_by_version.delete(this);
	}

	/** The default instance declared for this toolchain kind, or null. */
	static default() {
		return _toolchain_defaults.get(this) ?? null;
	}

	/** The default instance's version, or null when no default is set. */
	static defaultVersion() {
		const instance = this.default();
		return instance ? (instance.attrs.version ?? null) : null;
	}

	/** An explicit version if given, else the default instance's. */
	static resolveVersion(version) {
		if (version) return version;
		return this.defaultVersion();
	}

	/**
	 * An explicit or default version, throwing the standard "no X toolchain
	 * version specified and no default set" error otherwise.
	 *
	 * @param {string} [version]
	 * @param {string} [label] Display name for the error message; defaults to
	 *   this subclass's declared tool name.
	 * @returns {string}
	 */
	static requireVersion(version, label) {
		const resolved = this.resolveVersion(version);
		if (!resolved) {
			throw new Error(
				`no ${label ?? this.tool?.name ?? this.name} toolchain version specified and no default set`,
			);
		}
		return resolved;
	}

	/**
	 * The instance that declared a given version, if any — distinct from the
	 * default instance, since a version may be declared without being set as
	 * default. Falls back to the default instance when no instance declared
	 * that exact version (e.g. `version` came from elsewhere and happens to
	 * match nothing declared here).
	 *
	 * @param {string} [version]
	 * @returns {Toolchain|null}
	 */
	static instanceForVersion(version) {
		return (
			(version && _toolchain_by_version.get(this)?.get(version)) ||
			this.default()
		);
	}

	/** The `unverified` flag declared for a given version, else `false`. */
	static resolveUnverified(version) {
		return this.instanceForVersion(version)?.attrs.unverified ?? false;
	}

	/**
	 * Absolute path to this toolchain's binary; powers `imp @tool`
	 * dispatch. Subclasses must override.
	 *
	 * @returns {string|Promise<string>}
	 */
	bin() {
		throw new Error(`${this.constructor.name} must implement bin()`);
	}

	static _ensureRegistered(cls) {
		if (cls === Toolchain || _toolchain_registered.has(cls)) return;
		if (!cls.tool || cls.tool.__imp_tool_name !== true) {
			throw new Error(
				`${cls.name || "<anonymous>"}: Toolchain subclasses must declare ` +
					`'static tool = toolName(...)'`,
			);
		}
		_toolchain_registered.add(cls);
		product(cls, TOOLCHAIN, cls.tool, (handle) => handle.bin());
	}
}

/** Clear every toolchain kind's default instance (test isolation hook). */
export function __resetToolchainDefaultsForTest() {
	_toolchain_defaults.clear();
	_toolchain_by_version.clear();
}

/**
 * Declare a target and return a target handle.
 *
 * @category target
 * @param {object} opts
 * @param {string} opts.kind Stable target kind understood by extension rules.
 * @param {object} [opts.attrs={}] Typed attributes stored on the target. May contain nested
 *   target handles; those are extracted as dep edges automatically when opts.deps is omitted.
 * @param {Array<object>} [opts.deps] Explicit dependency list as handles or { target, mode } pairs.
 *   When omitted, deps are discovered by scanning opts.attrs for target handles.
 * @returns {object} An enriched target handle: { __imp, __id, kind, attrs }.
 */
export function target(opts) {
	return new Target(opts);
}

/**
 * Declare a plugin-managed raw cache directory.
 *
 * Named caches are intentionally opaque to the task cache. Actions receive a
 * stable directory path through IMP_NAMED_CACHE_<NAME>, and plugins decide
 * what to store there.
 *
 * @param {object} opts
 * @param {string} opts.name Stable cache name, using lowercase ASCII, digits,
 * hyphens, or underscores.
 * @param {boolean} [opts.shared] Share the cache across workspaces instead of
 * scoping it to this checkout. Only for immutable, version-keyed content
 * (toolchains): every workspace resolves the same slot, so nothing may ever
 * rewrite an existing key in place.
 * @returns {void}
 */
export function namedCache(opts) {
	__host_named_cache(opts.name, opts.shared === true);
}

/**
 * Register a goal, optionally with a callback that fully owns the goal
 * invocation.
 *
 * The built-in "build" goal is pre-registered. Extensions may register
 * additional goals. Duplicate goal names are silently ignored
 * (first-registration-wins). A goal's product is always the product named
 * after the goal itself (goals map uniformly onto products: build →
 * "build", fmt → "fmt", …); targets whose kind lacks that product are
 * skipped by wildcard selectors such as `//...`.
 *
 * @param {string} name Goal name, e.g. "test" or "fmt".
 * @param {(selection: Array<{id: number, address: string, kind: string, product: string}>) => (void | Promise<void>)} [fn]
 *   Optional. When provided, this callback is fully responsible for the goal
 *   invocation — it receives the resolved selection and native per-target
 *   product dispatch is skipped entirely, even on success. Use
 *   `resolveProducts(entry)` from within `fn` to look up each selected
 *   target's registered product function and drive your own resolve/fan-out/
 *   await loop (see build.js/run.js/test.js/fmt.js for the pattern).
 *   Throwing (or rejecting) aborts the whole invocation with that one error.
 *   If `fn` is omitted, the host dispatches every selected target's product
 *   function itself, exactly as before.
 * @param {object} [opts]
 * @param {Record<string, {description?: string}>} [opts.flags] Boolean flags
 *   this goal accepts on the CLI (e.g. `{ check: { description: "..." } }`
 *   becomes `--check`). Read back during goal execution via `goalFlags()`.
 *   Declaring a flag more than once (e.g. across re-evaluated modules) is
 *   idempotent, unlike the goal's callback/product, which is
 *   first-registration-wins.
 * @param {"required" | "none"} [opts.selection] Defaults to "required":
 *   invoking the goal without a selector is an error (use `//...` to select
 *   the whole workspace). "none" declares that the goal ignores target
 *   selection entirely — a selector-less invocation runs the callback with
 *   an empty selection (e.g. gen-builtin-lockfiles, which walks a registry
 *   instead of selected targets).
 * @returns {object} The product-name token for this goal's product; pass it
 *   to product() to register a target kind's implementation of the goal.
 *   Repeat registrations of the same goal return the same token.
 */
export function goal(name, fn, opts) {
	if (typeof name !== "string" || name === "") {
		throw new Error("goal(name, fn?, opts?) requires a non-empty string name");
	}
	const flags = opts && opts.flags ? opts.flags : {};
	const selection =
		opts && opts.selection !== undefined ? opts.selection : "required";
	if (selection !== "required" && selection !== "none") {
		throw new Error(
			`goal '${name}': opts.selection must be "required" or "none"`,
		);
	}
	const stack = new Error("goal registration").stack || "";
	const pid = __host_goal(
		name,
		"default",
		JSON.stringify(flags),
		selection === "none",
		stack,
	);
	if (fn !== undefined) {
		if (typeof fn !== "function") {
			throw new Error(
				"goal(name, fn?, opts?) expects fn to be a function when provided",
			);
		}
		__host_goal_callback(name, fn);
	}
	return _mint_product_name_token(name, pid);
}

/**
 * Read the flags resolved for the goal currently executing (declared via
 * `goal(name, fn, { flags })`), e.g. `{ check: true }`.
 *
 * Only callable from within a goal callback or product function while a goal
 * is executing; throws if called outside that context.
 *
 * @returns {Record<string, boolean>}
 */
export function goalFlags() {
	return JSON.parse(__host_current_goal_flags());
}

/**
 * Return the program arguments supplied after `--` to the current `run`
 * invocation. This is intentionally available only while a run product is
 * executing; other goals have no program argv.
 *
 * @returns {string[]}
 */
export function runArgs() {
	return JSON.parse(__host_run_args());
}

/**
 * Builders for declarative schemas — used both for workspace configuration
 * (`defineConfigSchema`) and Target subclass `static schema` (attrs
 * validation).
 *
 * Available descriptors are `field.int`, `field.string`, `field.bool`,
 * `field.enum(values)`, `field.object(shape)`, `field.map(key, value)`,
 * `field.array(item)`, and `field.target()`. Descriptor options are
 * `default` and `required`; map keys are represented as JSON object
 * property names. `field.target()` accepts a target handle (or dep-edge
 * wrapper from link()/profile()) and has no `default` — a dependency can't
 * be synthesized — only `required`. `field.array`/`field.target` are meant
 * for Target attrs schemas; config schemas have no use for target handles.
 *
 * @category configuration
 */
export const field = {
	int: (opts = {}) => ({ __impField: "int", ...opts }),
	string: (opts = {}) => ({ __impField: "string", ...opts }),
	bool: (opts = {}) => ({ __impField: "bool", ...opts }),
	enum: (values, opts = {}) => ({ __impField: "enum", values, ...opts }),
	object: (shape, opts = {}) => ({ __impField: "object", shape, ...opts }),
	map: (key, value, opts = {}) => ({
		__impField: "map",
		key,
		value,
		...opts,
	}),
	array: (item, opts = {}) => ({ __impField: "array", item, ...opts }),
	target: (opts = {}) => ({ __impField: "target", ...opts }),
};

// True for a field.target() descriptor, or a field.array() of one — the
// only shapes whose attrs value must stay a live JS handle rather than the
// validated/defaulted JSON __host_validate_target_attrs() returns.
function _is_target_field(fieldSchema) {
	if (!fieldSchema || typeof fieldSchema !== "object") return false;
	if (fieldSchema.__impField === "target") return true;
	if (fieldSchema.__impField === "array")
		return _is_target_field(fieldSchema.item);
	return false;
}

// cls → its composed schema (or null if no class in its chain declares
// one), memoized since it's invariant per class and Target construction is
// hot. `static schema` is a plain static field, so an undeclared subclass
// simply inherits its nearest ancestor's own `schema` via the prototype
// chain — walking own-property descriptors from Target down to cls (base
// first) and merging is what turns that shadow-by-default behavior into
// composition, later (more-derived) fields winning on conflicts.
const _composed_schema_cache = new WeakMap();
function _composed_schema(cls) {
	if (_composed_schema_cache.has(cls)) return _composed_schema_cache.get(cls);
	const layers = [];
	for (let c = cls; typeof c === "function"; c = Object.getPrototypeOf(c)) {
		const own = Object.getOwnPropertyDescriptor(c, "schema");
		if (own) layers.unshift(own.value);
	}
	const composed = layers.length ? Object.assign({}, ...layers) : null;
	_composed_schema_cache.set(cls, composed);
	return composed;
}

// Validate/default `attrs` against a Target subclass's composed schema,
// keeping target-typed fields as the original live handles (the host only
// ever sees their serialized { __imp_ref } / { __imp_dep_ref } form).
function _validate_target_attrs(schema, kind, attrs) {
	const encoded = __host_validate_target_attrs(
		kind,
		JSON.stringify(_serialize_attrs(schema)),
		JSON.stringify(_serialize_attrs(attrs)),
	);
	const validated = JSON.parse(encoded);
	const merged = {};
	for (const key of Object.keys(schema)) {
		const value = _is_target_field(schema[key]) ? attrs[key] : validated[key];
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

/**
 * Register the typed shape for a workspace configuration namespace.
 * The owning module must be imported before workspace configuration exports
 * are evaluated. A workspace may provide either an export named after the
 * namespace, such as `export const imp = { jsWorkers: 2 }`, or a
 * collision-free `<namespace>Config` export, such as
 * `export const odinConfig = { collections: { lib: "library" } }`.
 * Registered schemas are available through `imp config schema`.
 *
 * @category configuration
 * @param {string} namespace Configuration namespace.
 * @param {object} shape Object containing field descriptors.
 * @returns {void}
 */
export function defineConfigSchema(namespace, shape) {
	if (typeof namespace !== "string" || namespace.length === 0) {
		throw new Error(
			"defineConfigSchema(namespace, shape) requires a non-empty namespace",
		);
	}
	const encoded = JSON.stringify(_serialize_attrs(shape));
	if (encoded === undefined) {
		throw new Error(
			"defineConfigSchema(namespace, shape) requires a JSON-serializable shape",
		);
	}
	__host_define_config_schema(namespace, encoded);
}

defineConfigSchema("imp", {
	jsWorkers: field.int({ default: 1 }),
	jobs: field.int({ default: 1 }),
});

defineConfigSchema("cache", {
	gcMaxAgeDays: field.int({ default: 30 }),
});

/**
 * Merge JSON-serializable workspace configuration into a namespace.
 *
 * For static, known-shape configuration prefer exporting a matching object or
 * `<namespace>Config` object from imp.workspace.js; this imperative API
 * remains useful for dynamic and test-time configuration. Configuration is
 * evaluated before BUILD.js files when called from imp.workspace.js, and can
 * be read by rule functions via configuration().
 *
 * @category configuration
 * @param {string} namespace Stable configuration namespace, e.g. "odin".
 * @param {any} value JSON-serializable configuration value.
 * @returns {void}
 */
export function configure(namespace, value) {
	if (typeof namespace !== "string" || namespace.length === 0) {
		throw new Error(
			"configure(namespace, value) requires a non-empty namespace",
		);
	}
	const encoded = JSON.stringify(_serialize_attrs(value));
	if (encoded === undefined) {
		throw new Error(
			"configure(namespace, value) requires a JSON-serializable value",
		);
	}
	__host_configure(namespace, encoded);
}

/**
 * Read workspace configuration for a namespace.
 *
 * Declarative schemas are validated and defaulted during workspace loading;
 * this remains the read-side API for both declarative and imperative config.
 *
 * @category configuration
 * @param {string} namespace Stable configuration namespace, e.g. "odin".
 * @param {any} [fallback] Value returned when no namespace config exists.
 * @returns {any}
 */
export function configuration(namespace, fallback = undefined) {
	if (typeof namespace !== "string" || namespace.length === 0) {
		throw new Error("configuration(namespace) requires a non-empty namespace");
	}
	// Record the read on the current call frame so run()'s cache-key salt
	// (see run() below) can be scoped to only the namespaces actually read,
	// instead of the whole workspace_config map. See config-digest-scoping.md.
	_effective_context_entry(true).ctx.readNamespaces.add(namespace);
	const encoded = __host_configuration(namespace);
	_trace_effect({
		event: "effect",
		kind: "configuration",
		namespace,
		configured: encoded != null,
	});
	return encoded == null ? fallback : JSON.parse(encoded);
}

/**
 * Declare a mode axis (e.g. optimization level, cross-compilation target)
 * that can be overridden per-invocation via `--axis name=value`.
 *
 * This only registers the axis's shape (for CLI validation/defaulting); it
 * does not itself make the axis readable — call modeAxis() at execution
 * time to read the CLI-resolved value.
 *
 * @category configuration
 * @param {string} name Axis name, e.g. "opt".
 * @param {object} def
 * @param {"rebuild"|"output-select"} def.kind Whether resolving this axis to
 *   a different value requires a differently-invoked build ("rebuild") or
 *   just selects among outputs an existing build already produced
 *   ("output-select").
 * @param {string[]} [def.values] Closed set of valid values. Omit for a
 *   free-form axis (e.g. an arbitrary cross-compile target triple).
 * @param {string} def.default Value used when not overridden by --axis.
 * @returns {void}
 */
export function defineModeAxis(name, def) {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("defineModeAxis(name, def) requires a non-empty name");
	}
	const encoded = JSON.stringify(_serialize_attrs(def));
	if (encoded === undefined) {
		throw new Error(
			"defineModeAxis(name, def) requires a JSON-serializable def",
		);
	}
	__host_define_mode_axis(name, encoded);
}

/**
 * Declare a named partial bundle of mode-axis defaults, selectable with
 * `--profile name`. Entries omitted from a profile keep their axis's declared
 * default; explicit `--axis name=value` overrides the selected profile.
 *
 * @category configuration
 * @param {string} name Profile name, e.g. "windows-release".
 * @param {object.<string, string>} values Axis values to apply for this profile.
 * @returns {void}
 */
export function defineProfile(name, values) {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("defineProfile(name, values) requires a non-empty name");
	}
	const encoded = JSON.stringify(_serialize_attrs(values));
	if (encoded === undefined) {
		throw new Error(
			"defineProfile(name, values) requires JSON-serializable values",
		);
	}
	__host_define_profile(name, encoded);
}

/**
 * Apply a named build profile to one dependency edge. The profile overlays
 * the invocation-wide mode bundle while that dependency and its transitive
 * work are evaluated.
 *
 * @category target
 * @param {object} handle Target handle.
 * @param {string} name Declared profile name.
 * @returns {object} Target-like configured dependency handle.
 */
export function profile(handle, name) {
	if (!handle || handle.__imp !== true) {
		throw new Error("profile(handle, name) expects a Target handle");
	}
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("profile(handle, name) requires a non-empty profile name");
	}
	const base = handle.__imp_profile === true ? handle.handle : handle;
	const profiles = Object.freeze([
		...(handle.__imp_profile === true ? handle.profiles : []),
		name,
	]);
	const overrides = Object.freeze(
		profiles.reduce(
			(values, profileName) => ({
				...values,
				...JSON.parse(__host_mode_profile(profileName)),
			}),
			{},
		),
	);
	const configured = {
		__imp: true,
		__imp_profile: true,
		__id: base.__id,
		kind: base.kind,
		attrs: base.attrs,
		handle: base,
		profiles,
		overrides,
	};
	Object.defineProperty(configured, "label", {
		get: () => base.label,
	});
	return Object.freeze(configured);
}

/**
 * Read the CLI-resolved value of a declared mode axis.
 *
 * Backed by configuration("imp.mode"), so a call frame that reads a mode
 * axis is automatically tracked for run()'s cache-key scoping — see
 * config-digest-scoping.md.
 *
 * @category configuration
 * @param {string} name Axis name, as passed to defineModeAxis.
 * @returns {string}
 */
export function modeAxis(name) {
	if (typeof name !== "string" || name.length === 0) {
		throw new Error("modeAxis(name) requires a non-empty name");
	}
	const cfg = configuration("imp.mode");
	if (cfg == null || !(name in cfg)) {
		throw new Error(
			`modeAxis: axis "${name}" was not declared via defineModeAxis, or has not been resolved yet`,
		);
	}
	const overrides = _effective_context_entry(true).ctx.modeOverrides;
	return overrides && name in overrides ? overrides[name] : cfg[name];
}

/**
 * Read all configuration schemas registered by the loaded rule packages.
 * Primarily useful to documentation and introspection tooling.
 *
 * @returns {object} Schemas keyed by configuration namespace.
 */
export function configurationSchemas() {
	return JSON.parse(__host_configuration_schemas());
}

/**
 * Read high-level goal capabilities derived from product registration
 * provenance. Groups and tools come from their `//rules/<group>/<tool>`
 * module paths; no separate catalog is maintained.
 *
 * @returns {object} Capability tree keyed by rule group, goal, and tool.
 */
export function ruleCapabilities() {
	return JSON.parse(__host_rule_capabilities());
}

// ---------------------------------------------------------------------------
// Toolchain acquisition primitives
// ---------------------------------------------------------------------------

/**
 * Download a URL to the local download cache.
 * @param {string} url
 * @returns {string} Local path to the downloaded file.
 */
export function download(url) {
	return __host_download(url);
}

/**
 * Extract an archive to a directory.
 * @param {string} archive Path to the archive file.
 * @param {string} dest    Destination directory.
 * @param {object} opts
 * @param {string} opts.format Archive format: "tar.gz", "tgz", or "zip".
 * @param {number} [opts.strip_components=0] Number of leading path components to strip (tar.gz only).
 * @returns {void}
 */
export function extract(archive, dest, opts) {
	__host_extract(archive, dest, opts.format, opts.strip_components || 0);
}

/**
 * Detect the current platform.
 * @returns {{ os: string, arch: string }}
 */
export function platformInfo() {
	return JSON.parse(__host_platform_info());
}

/**
 * Compute the SHA-256 digest of a file.
 * @param {string} path
 * @returns {string} Hex-encoded digest.
 */
export function sha256(path) {
	return __host_sha256(path);
}

/**
 * Size in bytes of a file.
 * @param {string} path
 * @returns {number}
 */
export function file_size(path) {
	return __host_file_size(path);
}

/**
 * Store a file or directory into a named cache under a key.
 * @param {string} name   Cache name (matches a namedCache() declaration).
 * @param {string} key    Sub-key within the cache (e.g. "dev-2026-03/linux-x86_64").
 * @param {string} source Path to the file or directory to cache.
 */
export function cachePut(name, key, source) {
	__host_cache_put(name, key, source);
}

/**
 * Retrieve the path of a cached item.
 * @param {string} name Cache name.
 * @param {string} key  Sub-key.
 * @returns {string|null} Local path if the key exists, null otherwise.
 */
export function cacheGet(name, key) {
	return __host_cache_get(name, key);
}

/**
 * Check whether a key exists in a named cache.
 * @param {string} name Cache name.
 * @param {string} key  Sub-key.
 * @returns {boolean}
 */
export function cacheHas(name, key) {
	return __host_cache_has(name, key);
}

/**
 * Start a named, host-managed persistent worker process (e.g. a build-cache
 * daemon like sccache), or return its existing handle if one is already
 * running. Idempotent and safe to call from multiple concurrent run()s for
 * the same name: the host spawns it at most once and every caller gets the
 * same handle.
 *
 * Unlike run(), this process is not sandboxed and outlives any single
 * run() — it's meant for sidecars that need to survive across many builds,
 * not for build steps themselves.
 *
 * @param {string} name Worker name, scoped to this workspace.
 * @param {object} opts
 * @param {string[]} opts.argv Command that starts the worker (must exit once
 *   the worker is up, e.g. a `--start-server`-style daemonizing command).
 * @param {string[]} [opts.env] Extra "KEY=VALUE" environment entries for both
 *   the start command and the health check.
 * @param {string[]} [opts.healthCheckArgv] Command that exits 0 once the
 *   worker is ready to use; also used to detect a since-died worker on reuse.
 * @returns {Promise<{homeDir: string, tmpDir: string, port: number}>}
 *   `homeDir`/`tmpDir` are stable directories (not sandbox-scoped) the worker
 *   was started with; `port` is a TCP port deterministically derived from
 *   (workspace, name), handed to the worker as `IMP_WORKER_PORT`, for
 *   sidecars that need a private, collision-free port to listen on.
 */
export async function workerStart(name, opts) {
	const json = await __host_worker_start(name, {
		argv: opts.argv,
		env: opts.env ?? [],
		healthCheckArgv: opts.healthCheckArgv ?? [],
	});
	return JSON.parse(json);
}

/**
 * Look up a named worker's handle without spawning it.
 *
 * @param {string} name Worker name.
 * @returns {{homeDir: string, tmpDir: string, port: number}|null} `null` if
 *   it has never been started (or never successfully so) this invocation.
 */
export function workerGet(name) {
	const json = __host_worker_get(name);
	return json ? JSON.parse(json) : null;
}

/**
 * List workspace files below a workspace-rooted directory.
 *
 * Returned paths are module specifiers without the trailing `.js`, so they can
 * be passed directly to dynamic import().
 *
 * @param {object} opts
 * @param {string} opts.root Workspace-rooted directory, e.g. "//rules/odin".
 * @param {string} [opts.suffix] File suffix to include, e.g. "_test.js".
 * @param {boolean} [opts.recursive=true] Whether to descend into subdirectories.
 * @returns {string[]} Sorted workspace module specifiers.
 */
export function workspaceFiles(opts) {
	return JSON.parse(
		__host_workspace_files(
			opts.root,
			opts.suffix || "",
			opts.recursive !== false,
		),
	);
}

/**
 * List workspace source files matching Rust regular expressions.
 *
 * Returned paths are workspace-relative, using `/` separators.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Workspace-relative directory to search.
 * @param {string[]} opts.include Regexes; a file is included if any matches.
 * @param {string[]} [opts.exclude=[]] Regexes; a file is excluded if any matches.
 * @returns {string[]} Sorted workspace-relative file paths.
 */
export function workspaceSourceFiles(opts) {
	if (!opts || !Array.isArray(opts.include)) {
		throw new Error(
			"workspaceSourceFiles({ root?, include, exclude? }) requires include regexes",
		);
	}
	return JSON.parse(
		__host_workspace_source_files(
			opts.root || ".",
			JSON.stringify(opts.include),
			JSON.stringify(opts.exclude || []),
		),
	);
}

/**
 * List source files not owned by any loaded target.
 *
 * Returned paths are workspace-relative, using `/` separators.
 *
 * @param {object} opts
 * @param {string} [opts.root="."] Workspace-relative directory to search.
 * @param {string[]} opts.include Glob patterns matched relative to root.
 * @param {string[]} [opts.exclude=[]] Glob patterns excluded relative to root.
 * @returns {string[]} Sorted workspace-relative file paths.
 */
export function allUnowned(opts) {
	if (!opts || !Array.isArray(opts.include)) {
		throw new Error(
			"allUnowned({ root?, include, exclude? }) requires include glob patterns",
		);
	}
	return JSON.parse(
		__host_all_unowned(
			opts.root || ".",
			JSON.stringify(opts.include),
			JSON.stringify(opts.exclude || []),
		),
	);
}

/**
/**
 * Retrieve the kind, attrs, and dep handles for a target handle.
 *
 * @param {object} handle A target handle returned by target().
 * @returns {{ kind: string, attrs: object, deps: Array<{ handle: object, mode: string|null }> }}
 */
export function hydrateTarget(handle) {
	if (!handle || handle.__imp !== true) {
		throw new Error("hydrateTarget: expected a target handle");
	}
	const hydrated = JSON.parse(__host_hydrate_target(handle.__id));
	hydrated.deps = (hydrated.deps || []).map((dep) => ({
		...dep,
		handle: (function () {
			let result =
				globalThis.__imp_resolve_handle(dep.handle.__id) || dep.handle;
			if (dep.overrides !== null && dep.overrides !== undefined) {
				result = link(result, dep.overrides);
			}
			for (const profileName of dep.profiles || []) {
				result = profile(result, profileName);
			}
			return result;
		})(),
	}));
	return hydrated;
}

/**
 * Return the workspace address for a target handle, e.g. "//:app".
 *
 * @param {object} handle A target handle returned by target().
 * @returns {string}
 */
export function targetAddress(handle) {
	if (!handle || handle.__imp !== true) {
		throw new Error("targetAddress: expected a target handle");
	}
	return __host_target_address(handle.__id);
}

/**
 * List loaded workspace targets.
 *
 * Anonymous target handles created outside BUILD exports are omitted because
 * they do not have stable workspace addresses.
 *
 * @param {string} [kind] Optional target kind filter.
 * @returns {Array<{ id: number, address: string, kind: string, attrs: object, handle: object }>}
 */
export function workspaceTargets(kind = undefined) {
	if (kind !== undefined && typeof kind !== "string") {
		throw new Error(
			"workspaceTargets(kind?) expects kind to be a string when provided",
		);
	}
	const targets = JSON.parse(__host_workspace_targets(kind ?? ""));
	_trace_effect({
		event: "effect",
		kind: "workspaceTargets",
		target_kind: kind ?? null,
		count: targets.length,
	});
	return targets.map((target) => ({
		...target,
		handle: globalThis.__imp_resolve_handle(target.id) || {
			__imp: true,
			__id: target.id,
			kind: target.kind,
			attrs: target.attrs || {},
		},
	}));
}

/**
 * List the targets actually selected for the goal currently executing — the
 * CLI-resolved roots for this invocation, as opposed to workspaceTargets(),
 * which always returns every matching target in the whole workspace
 * regardless of what was selected on the command line.
 *
 * Only callable from within a product function while a goal is executing
 * (e.g. `imp goal vs //:pkg`); throws if called outside that context (e.g.
 * from generate-build product evaluation or a rules-test module).
 *
 * @param {string} [kind] Optional target kind filter.
 * @returns {Array<{ id: number, address: string, kind: string, product: string, handle: object }>}
 */
export function selectedTargets(kind = undefined) {
	if (kind !== undefined && typeof kind !== "string") {
		throw new Error(
			"selectedTargets(kind?) expects kind to be a string when provided",
		);
	}
	const all = JSON.parse(__host_selected_targets());
	const targets = kind === undefined ? all : all.filter((t) => t.kind === kind);
	_trace_effect({
		event: "effect",
		kind: "selectedTargets",
		target_kind: kind ?? null,
		count: targets.length,
	});
	return targets.map((target) => ({
		...target,
		handle: globalThis.__imp_resolve_handle(target.id) || {
			__imp: true,
			__id: target.id,
			kind: target.kind,
			attrs: {},
		},
	}));
}

/**
 * Resolve a selection entry to the product functions registered for its
 * kind and product — one per tool, since several tools may implement the
 * same product (e.g. two formatters) — without invoking them. For goal
 * callbacks that drive their own resolve/fan-out/await loop
 * (see build.js/run.js/test.js/fmt.js): `selection.flatMap(resolveProducts)`.
 *
 * @param {{id: number, address: string, kind: string, product: string|object}} entry
 *   `product` may be a host-serialized string (as selection entries arrive)
 *   or a product-name token (when a goal callback remaps, e.g. fmt --check).
 * @returns {Array<{label: string, tool: string, fn: function, handle: object}>}
 *   The label carries the tool (`addr#product@tool`) only when several tools
 *   register the product, keeping single-tool output unchanged.
 */
export function resolveProducts(entry) {
	let product = entry.product;
	if (product && product.__imp_product_name === true) {
		product = product.name;
	} else if (typeof product !== "string" || product === "") {
		throw new Error(
			"resolveProducts(entry) requires entry.product to be a product-name token or string",
		);
	}
	const by_tool = _products_by_kind_name.get(`${entry.kind}:${product}`);
	if (by_tool === undefined || by_tool.size === 0) {
		throw new Error(
			`no product '${product}' for kind '${entry.kind}' (target '${entry.address}')`,
		);
	}
	const handle = globalThis.__imp_resolve_handle(entry.id);
	return [...by_tool.entries()].map(([tool, fn]) => ({
		label:
			by_tool.size === 1
				? `${entry.address}#${product}`
				: `${entry.address}#${product}@${tool}`,
		tool,
		fn,
		handle,
	}));
}

/**
 * Look up and invoke the product registered under an arbitrary role `name`
 * for a target handle's kind, e.g. productFor(moldHandle, ODIN_LINKER).
 * Generalizes the fixed-name "toolchain" lookup invokeToolchainProduct() uses
 * for `imp @tool` dispatch to any role name, so rule code can dynamically
 * resolve a capability (linker, link driver, ...) off a handle without
 * statically importing every module that might supply it.
 *
 * @param {object} handle Target handle or link() edge reference whose kind determines which product resolves.
 * @param {object} nameToken Product-name token, e.g. ODIN_LINKER or TOOLCHAIN.
 * @returns {*} Whatever the registered product function returns (often a Promise).
 */
export function productFor(handle, nameToken) {
	const { name } = _product_name_of(nameToken, "productFor()");
	if (!handle || handle.__imp !== true) {
		throw new Error(`productFor(handle, "${name}") expects a target handle`);
	}
	const { handle: baseHandle, outputOverrides } = _unwrap_dep_edge(handle);
	const by_tool = _products_by_kind_name.get(`${baseHandle.kind}:${name}`);
	if (by_tool === undefined || by_tool.size === 0) {
		throw new Error(
			`target kind '${baseHandle.kind}' has no '${name}' product registered`,
		);
	}
	// Role lookups resolve a single provider; a kind with several tools
	// registering the same role product is ambiguous by construction.
	if (by_tool.size > 1) {
		throw new Error(
			`target kind '${baseHandle.kind}' has '${name}' products from several tools ` +
				`(${[...by_tool.keys()].join(", ")}); productFor() resolves a single provider`,
		);
	}
	const fn = by_tool.values().next().value;
	// fn is the memo()-wrapped product function; passing the still-wrapped
	// handle lets memo() apply any nested profile()'s mode-axis overlay and
	// strip wrapper layers itself, so direct calls and productFor() agree.
	const result = fn(handle);
	return _resolve_named_output_result(
		result,
		outputOverrides || {},
		new Set(Object.keys(outputOverrides || {})),
		`target kind '${baseHandle.kind}' product '${name}'`,
	);
}

/**
 * Resolve a live target handle by id and invoke its kind's registered
 * "toolchain" product, e.g. for `imp @odin ...` direct tool dispatch: the
 * handle's kind determines which registered resolver (if any) turns it into
 * an absolute binary path. Throws if the kind has no "toolchain" product
 * registered, i.e. the handle isn't toolchain-shaped.
 *
 * @param {number} id Target handle id, as returned by workspaceTargets()/__host_target.
 * @returns {string|Promise<string>} Absolute path to the toolchain's binary.
 */
export function invokeToolchainProduct(id) {
	const handle = globalThis.__imp_resolve_handle(id);
	if (!handle) {
		throw new Error(`no live handle for target id ${id}`);
	}
	const by_tool = _products_by_kind_name.get(`${handle.kind}:toolchain`);
	if (by_tool === undefined || by_tool.size === 0) {
		throw new Error(
			`target kind '${handle.kind}' has no 'toolchain' product (not toolchain-shaped)`,
		);
	}
	return productFor(handle, TOOLCHAIN);
}

/**
 * Collect all targets of a given kind reachable from a handle (depth-first, deduped).
 *
 * @param {object} handle Root target handle.
 * @param {Function} kindClass Target subclass to collect, e.g. OdinPackage.
 * @returns {object[]} Handles of all matching targets in the transitive closure.
 */
export function gatherTransitiveClosure(handle, kindClass) {
	const kind = _kind_of(kindClass, "gatherTransitiveClosure()");
	const visited = new Set();
	const result = [];
	function walk(h) {
		if (!h || h.__imp !== true) return;
		const id = h.__id;
		if (visited.has(id)) return;
		visited.add(id);
		const t = hydrateTarget(h);
		if (t.kind === kind) result.push(h);
		for (const dep of t.deps) walk(dep.handle);
	}
	walk(handle);
	return result;
}

/**
 * Register a JS export as the implementation of a target-constructor rule
 * name, so codegen'd BUILD.js files can reference the rule by name without
 * knowing which module defines it.
 *
 * @param {object} opts
 * @param {string} opts.rule Rule name as referenced by generated BUILD.js files.
 * @param {string} opts.importFrom Module specifier to import the rule from.
 * @param {string} [opts.importName] Export name to import, if different from `rule`.
 * @returns {void}
 */
export function registerBuildRule(opts) {
	if (
		!opts ||
		typeof opts.rule !== "string" ||
		typeof opts.importFrom !== "string"
	) {
		throw new Error(
			"registerBuildRule({ rule, importFrom, importName? }) requires rule and importFrom",
		);
	}
	__host_register_build_rule(
		opts.rule,
		opts.importFrom,
		opts.importName || opts.rule,
	);
}

/**
 * Construct a lazy reference to another target by workspace address, for use
 * in attrs before the referenced target has necessarily been declared.
 *
 * @param {string} address Workspace target address, e.g. "//lib:foo".
 * @returns {object} An opaque target-reference value.
 */
export function targetRef(address) {
	if (typeof address !== "string" || !address.startsWith("//")) {
		throw new Error("targetRef(address) requires a workspace target address");
	}
	return { __imp_target_ref: true, address };
}

// ---------------------------------------------------------------------------
// Product-name tokens and target-kind classes
// ---------------------------------------------------------------------------

const _declared_product_names = new Map(); // name → frozen token; persists across resetMemoState
const _kind_class_by_name = new Map(); // kind string → Target subclass; persists across resetMemoState

function _mint_product_name_token(name, pid) {
	const existing = _declared_product_names.get(name);
	if (existing !== undefined && existing.__pid === pid) return existing;
	const token = Object.freeze({ __imp_product_name: true, name, __pid: pid });
	_declared_product_names.set(name, token);
	return token;
}

/**
 * Declare a product name and return its token. A name may be declared only
 * once per workspace (per declaring module — re-evaluation is idempotent);
 * every other module that registers or looks up a product under this name
 * must import the token, which guarantees the declaring module is loaded.
 *
 * @category product
 * @param {string} name Product name, e.g. "cc-toolchain" or "odin-linker".
 * @returns {object} Frozen token accepted by product()/productFor()/resolveProducts().
 */
export function productName(name) {
	if (typeof name !== "string" || name === "") {
		throw new Error("productName(name) requires a non-empty string");
	}
	const stack = new Error("product name declaration").stack || "";
	const pid = __host_declare_product_name(name, stack, false);
	return _mint_product_name_token(name, pid);
}

function _builtin_product_name(name) {
	const pid = __host_declare_product_name(name, "", true);
	return _mint_product_name_token(name, pid);
}

const _declared_tool_names = new Map(); // name → frozen token; persists across resetMemoState

/**
 * Declare a tool name and return its token. Every product registration names
 * the tool that implements it (products are keyed `(kind, product, tool)`,
 * so several tools can implement the same product for a kind). Like product
 * names, a tool name is declared once per workspace and every other module
 * must import the token — for toolchain-backed tools, use the toolchain
 * class's `static tool` token instead of redeclaring.
 *
 * @category product
 * @param {string} name Tool name, e.g. "ruff" or "clippy".
 * @returns {object} Frozen token accepted by product().
 */
export function toolName(name) {
	if (typeof name !== "string" || name === "") {
		throw new Error("toolName(name) requires a non-empty string");
	}
	const stack = new Error("tool name declaration").stack || "";
	const tid = __host_declare_tool_name(name, stack);
	const existing = _declared_tool_names.get(name);
	if (existing !== undefined && existing.__tid === tid) return existing;
	const token = Object.freeze({ __imp_tool_name: true, name, __tid: tid });
	_declared_tool_names.set(name, token);
	return token;
}

// Coerce a tool argument to { name, tid }. Only declared tokens are accepted
// — a bare string cannot prove its declaring module is loaded.
function _tool_name_of(value, api) {
	if (value && value.__imp_tool_name === true) {
		return { name: value.name, tid: value.__tid };
	}
	throw new Error(
		`${api} requires a tool-name token; use the token returned by toolName(), ` +
			`or a toolchain class's 'static tool' token`,
	);
}

/** Tokens for the built-in goals' products, plus the "toolchain" role used
 * by `imp @tool` dispatch. Import these instead of writing name literals:
 * `product(PythonApp, BUILD, fn)`. */
export const BUILD = _builtin_product_name("build");
export const TEST = _builtin_product_name("test");
export const FMT = _builtin_product_name("fmt");
export const LINT = _builtin_product_name("lint");
export const PACKAGE = _builtin_product_name("package");
export const RUN = _builtin_product_name("run");
export const TOOLCHAIN = _builtin_product_name("toolchain");

// Coerce a product-name argument to { name, pid }. Only declared tokens are
// accepted — a bare string cannot prove its declaring module is loaded.
function _product_name_of(value, api) {
	if (value && value.__imp_product_name === true) {
		return { name: value.name, pid: value.__pid };
	}
	throw new Error(
		`${api} requires a product-name token; use the token returned by ` +
			`productName()/goal(), or a builtin like BUILD from imp:core`,
	);
}

// Coerce a target-kind argument to its kind string. The class *is* the kind
// declaration: it must subclass Target, carry `static kind`, and be the only
// class claiming that kind string.
function _kind_of(cls, api) {
	if (
		typeof cls !== "function" ||
		!(cls === Target || cls.prototype instanceof Target)
	) {
		throw new Error(`${api} requires a Target subclass as the kind argument`);
	}
	if (typeof cls.kind !== "string" || cls.kind === "") {
		throw new Error(
			`${api}: class ${cls.name || "<anonymous>"} must declare 'static kind = "..."'`,
		);
	}
	const existing = _kind_class_by_name.get(cls.kind);
	if (existing !== undefined && existing !== cls) {
		throw new Error(
			`target kind '${cls.kind}' is declared by two classes ` +
				`(${existing.name || "<anonymous>"} and ${cls.name || "<anonymous>"})`,
		);
	}
	_kind_class_by_name.set(cls.kind, cls);
	const schema = _composed_schema(cls);
	if (schema !== null) {
		__host_register_target_schema(cls.kind, JSON.stringify(schema));
	}
	return cls.kind;
}

/**
 * Read the composed `static schema` (own schema merged over every
 * ancestor's, base-first — see _composed_schema) for every Target subclass
 * seen so far via product()/expand()/targetKind() (i.e. every kind with a
 * registered implementation), keyed by kind. Mirrors configurationSchemas():
 * a schema is a plain static class field rather than something registered
 * through a host call, so this — like configurationSchemas() — only
 * reflects modules that have actually been loaded.
 *
 * @returns {object} Schemas keyed by target kind, omitting kinds with no
 *   declared schema anywhere in their chain.
 */
export function targetSchemas() {
	const out = {};
	for (const [kind, cls] of _kind_class_by_name) {
		const schema = _composed_schema(cls);
		if (schema !== null) out[kind] = schema;
	}
	return out;
}

/**
 * Mint an anonymous Target subclass for a kind string — for test fixtures
 * and generator kinds that have no real rule class. Real rules should
 * declare a proper `class Foo extends Target { static kind = "..." }`
 * instead, so the class remains the single declaration site for the kind.
 *
 * @param {string} name Target kind, e.g. "cmake-lib".
 * @returns {Function} A Target subclass with `static kind = name`.
 */
export function targetKind(name) {
	if (typeof name !== "string" || name === "") {
		throw new Error("targetKind(name) requires a non-empty string");
	}
	const cls = class extends Target {
		static kind = name;
	};
	Object.defineProperty(cls, "name", { value: name });
	return cls;
}

const _linked_edge_cache = new WeakMap();

function _canonical_link_overrides(overrides) {
	if (
		overrides === null ||
		typeof overrides !== "object" ||
		Array.isArray(overrides)
	) {
		throw new Error(
			"link(handle, overrides) requires an object of axis=value entries",
		);
	}
	const result = {};
	for (const name of Object.keys(overrides).sort()) {
		const value = overrides[name];
		if (typeof value !== "string") {
			throw new Error(
				`link(handle, overrides) requires string values; '${name}' was ${typeof value}`,
			);
		}
		result[name] = value;
	}
	return Object.freeze(result);
}

/**
 * Select a dependency edge's product type: an object of output-select
 * mode-axis values (see defineModeAxis's `kind: "output-select"`) that
 * `productFor()` uses to pick a branch of the producer's namedOutput()
 * result after it has already built — never a rebuild. This is declaration
 * metadata only.
 *
 * `link()` composes with profile(): nest a profile()-wrapped handle to also
 * overlay that dependency's rebuild-axis mode bundle, e.g.
 * `link(profile(dep, "release"), { linking: "shared" })`. Rebuild-axis
 * values belong to profile(), not link() — passing one here throws.
 *
 * @category target
 * @param {object} handle Base target handle, optionally profile()-wrapped.
 * @param {object.<string, string>} overrides Per-edge output-select axis values.
 * @returns {object} Immutable linked-edge reference accepted by productFor() and deps.
 */
export function link(handle, overrides) {
	if (!handle || handle.__imp !== true) {
		throw new Error("link(handle, overrides) expects a Target handle");
	}
	const canonical = _canonical_link_overrides(overrides);
	const classified = JSON.parse(
		__host_classify_link_overrides(JSON.stringify(canonical)),
	);
	const rebuildAxes = Object.keys(classified.rebuild);
	if (rebuildAxes.length > 0) {
		throw new Error(
			"link(handle, overrides) only accepts output-select axes (product type); " +
				`rebuild axis(es) ${rebuildAxes.map((a) => `'${a}'`).join(", ")} must be set via profile() instead`,
		);
	}
	const overridesKey = JSON.stringify(canonical);
	let byOverrides = _linked_edge_cache.get(handle);
	if (byOverrides === undefined) {
		byOverrides = new Map();
		_linked_edge_cache.set(handle, byOverrides);
	}
	const existing = byOverrides.get(overridesKey);
	if (existing !== undefined) return existing;
	const reference = {
		__imp: true,
		__imp_link: true,
		__id: handle.__id,
		kind: handle.kind,
		attrs: handle.attrs,
		handle,
		overrides: canonical,
	};
	Object.defineProperty(reference, "label", {
		get: () => handle.label,
	});
	Object.freeze(reference);
	byOverrides.set(overridesKey, reference);
	return reference;
}

/**
 * Return a product result with values selected by an output-select mode axis.
 * `productFor()` resolves the wrapper after the producer has completed, so
 * selecting a different output never rebuilds that producer.
 *
 * @category product
 * @param {string} axis Declared mode axis whose kind is "output-select".
 * @param {object} values Non-empty map from axis values to product results.
 * @returns {object} Opaque result resolved automatically by productFor().
 */
export function namedOutput(axis, values) {
	if (typeof axis !== "string" || axis.length === 0) {
		throw new Error("namedOutput(axis, values) requires a non-empty axis name");
	}
	if (
		values === null ||
		typeof values !== "object" ||
		Array.isArray(values) ||
		Object.keys(values).length === 0
	) {
		throw new Error(
			"namedOutput(axis, values) requires a non-empty object of output values",
		);
	}
	__host_validate_named_output_axis(axis);
	return Object.freeze({
		__imp_named_output: true,
		axis,
		values: Object.freeze({ ...values }),
	});
}

function _select_named_output(value, requiredAxes, source) {
	while (value && value.__imp_named_output === true) {
		const selected = modeAxis(value.axis);
		if (!(selected in value.values)) {
			throw new Error(
				`${source} has no named output for ${value.axis}=${selected}; ` +
					`available values: ${Object.keys(value.values).join(", ")}`,
			);
		}
		requiredAxes.delete(value.axis);
		value = value.values[selected];
	}
	if (requiredAxes.size > 0) {
		throw new Error(
			`${source} does not return namedOutput() for linked output-select axis/axes: ` +
				[...requiredAxes].join(", "),
		);
	}
	return value;
}

function _resolve_named_output_result(
	result,
	outputOverrides,
	requiredAxes,
	source,
) {
	const select = (value) =>
		_with_mode_overrides(outputOverrides, () =>
			_select_named_output(value, new Set(requiredAxes), source),
		);
	return result && typeof result.then === "function"
		? result.then(select)
		: select(result);
}

// ---------------------------------------------------------------------------
// memo() — memoized async build functions (Phase 1)
// ---------------------------------------------------------------------------

const _memo_fn_ids = new WeakMap();
let _memo_fn_counter = 0;
const _fn_id_names = new Map(); // fn_id → fn.name; persists across resetMemoState
const _product_fn_info = new Map(); // fn_id → product_name; persists across resetMemoState
const _products_by_kind_name = new Map(); // "kind:name" → Map(tool → memoized fn); persists across resetMemoState

function _stable_function_id(fn) {
	let id = _memo_fn_ids.get(fn);
	if (id === undefined) {
		id = (fn.name || "<anonymous>") + "#" + ++_memo_fn_counter;
		_memo_fn_ids.set(fn, id);
		_fn_id_names.set(id, fn.name || "<anonymous>");
	}
	return id;
}

// Serialize args to a stable string. Target handles ({ __imp: true, __id })
// are replaced with { __imp_ref: <id> } so identity is by numeric ID.
function _stable_digest(args) {
	return JSON.stringify(args, function (key, value) {
		if (
			value !== null &&
			typeof value === "object" &&
			(value.__imp_link === true || value.__imp_profile === true)
		) {
			// link()'s own output-select overrides never change what the
			// memoized product function computes — they only pick a branch
			// of its already-built result afterward (productFor()) — so they
			// must not fragment the memo cache key. Only a nested profile()
			// (which does overlay modeAxis() reads) is digest-relevant.
			const { handle, profiles } = _unwrap_dep_edge(value);
			return profiles && profiles.length > 0
				? { __imp_dep_ref: handle.__id, profiles }
				: { __imp_ref: handle.__id };
		}
		if (
			value !== null &&
			typeof value === "object" &&
			value.__imp === true &&
			typeof value.__id === "number"
		) {
			return { __imp_ref: value.__id };
		}
		return value;
	});
}

let _memo_table = new Map();
let _memo_deps = [];
let _memo_trace = [];
let _key_display = new Map(); // key_string → "fnName(arg, ...)"
let _key_product_call = new Map(); // key_string → {target_id, product_name} for product calls

// Task-tree tracking. Each memo evaluation is a node with a numeric id. The
// active owner and call stack are stored in an async context, and the embedded
// QuickJS promise hook calls the __imp_promise_context_* globals below to
// restore that context around promise jobs. That keeps concurrent Promise.all
// branches from overwriting each other's owner/stack state.
let _memo_context_counter = 0;
let _current_memo_context_id = 0;
let _memo_contexts = new Map([
	[
		0,
		{
			owner: null,
			stack: [],
			stackSet: new Set(),
			readNamespaces: new Set(),
			modeOverrides: null,
		},
	],
]);
let _active_memo_context_ids = new Set();
let _promise_contexts = new WeakMap();
let _promise_context_stack = [];
let _promise_job_context_stack = [];
let _promise_context_override = null;
let _promise_context_override_stack = [];
let _memo_node_counter = 0;
let _memo_node_labels = new Map();
let _memo_context_labels = new Map([[0, ""]]);
let _js_worker_count = 1;
let _js_available_lanes = [0];
let _js_lane_queue = [];

function _emit_js_lane(state, slot, id, label) {
	if (typeof globalThis.__host_js_lane_event === "function") {
		globalThis.__host_js_lane_event(state, slot, id, label);
	}
}

function _reset_js_lanes() {
	_js_available_lanes = [];
	for (let i = 0; i < _js_worker_count; i++) {
		_js_available_lanes.push(i);
	}
	_js_lane_queue = [];
}

globalThis.__imp_set_js_workers = function (count) {
	const parsed = Number(count);
	_js_worker_count =
		Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
	_reset_js_lanes();
};

function _grant_js_lane(slot, waiter) {
	_emit_js_lane("start", slot, waiter.id, waiter.label);
	waiter.run(slot);
}

function _take_js_lane(id, label) {
	const taskId = id || 0;
	const taskLabel = label || "js";
	if (_js_available_lanes.length > 0) {
		const slot = _js_available_lanes.shift();
		_emit_js_lane("start", slot, taskId, taskLabel);
		return slot;
	}
	return null;
}

function _enqueue_js_lane(id, label, run) {
	return new Promise((resolve, reject) => {
		_js_lane_queue.push({
			id: id || 0,
			label: label || "js",
			run: (slot) => {
				try {
					resolve(run(slot));
				} catch (error) {
					reject(error);
				}
			},
		});
	});
}

function _release_js_lane(slot, id) {
	_emit_js_lane("clear", slot, id || 0, "");
	const waiter = _js_lane_queue.shift();
	if (waiter !== undefined) {
		_grant_js_lane(slot, waiter);
	} else {
		_js_available_lanes.push(slot);
	}
}

function _with_js_lane(id, label, fn) {
	const run = (slot) => {
		try {
			const result = fn();
			_release_js_lane(slot, id);
			return result;
		} catch (error) {
			_release_js_lane(slot, id);
			throw error;
		}
	};
	const slot = _take_js_lane(id, label);
	if (slot !== null) {
		return Promise.resolve(run(slot));
	}
	return _enqueue_js_lane(id, label, run);
}

function _context_label(contextId) {
	return _memo_context_labels.get(contextId) || "";
}

function _context_owner(contextId) {
	const ctx = _memo_contexts.get(contextId);
	return ctx && ctx.owner !== null ? ctx.owner : 0;
}

function _call_with_context(contextId, fn) {
	const prevOverride = _promise_context_override;
	const prevContextId = _current_memo_context_id;
	_promise_context_override_stack.push(prevOverride);
	_promise_job_context_stack.push(prevContextId);
	_promise_context_override = contextId;
	_current_memo_context_id = contextId;
	try {
		return fn();
	} catch (error) {
		_promise_context_override = _promise_context_override_stack.pop();
		_current_memo_context_id = _promise_job_context_stack.pop();
		throw error;
	}
}

function _clone_context(ctx) {
	return {
		owner: ctx.owner,
		stack: ctx.stack.slice(),
		stackSet: new Set(ctx.stackSet),
		// Deliberately NOT inherited from the parent: each frame tracks only
		// the configuration namespaces its own body reads directly. A
		// callee's config-dependent behavior is already captured in the
		// result it returns, so invalidation propagates to the caller via
		// args_digest without the caller needing the callee's reads too.
		readNamespaces: new Set(),
		// Link overrides are ambient for a linked product call and therefore
		// must flow to all async children of that call.
		modeOverrides: ctx.modeOverrides,
	};
}

function _current_context() {
	let ctx = _memo_contexts.get(_current_memo_context_id);
	if (ctx === undefined) {
		ctx = {
			owner: null,
			stack: [],
			stackSet: new Set(),
			readNamespaces: new Set(),
			modeOverrides: null,
		};
		_memo_contexts.set(_current_memo_context_id, ctx);
	}
	return ctx;
}

function _single_active_context_id() {
	let only = null;
	for (const contextId of _active_memo_context_ids) {
		if (only !== null) return null;
		only = contextId;
	}
	return only;
}

function _effective_context_entry(useSingleActive = false) {
	const ctx = _current_context();
	if (ctx.owner !== null || ctx.stack.length > 0) {
		return { id: _current_memo_context_id, ctx };
	}
	if (useSingleActive && _current_memo_context_id === 0) {
		const activeContextId = _single_active_context_id();
		if (activeContextId !== null) {
			return {
				id: activeContextId,
				ctx: _memo_contexts.get(activeContextId) || ctx,
			};
		}
	}
	return { id: _current_memo_context_id, ctx };
}

function _effective_context(useSingleActive = false) {
	return _effective_context_entry(useSingleActive).ctx;
}

function _fork_context(owner, baseContext = _effective_context(), label = "") {
	const id = ++_memo_context_counter;
	const ctx = _clone_context(baseContext);
	ctx.owner = owner;
	_memo_contexts.set(id, ctx);
	_memo_context_labels.set(id, label);
	_active_memo_context_ids.add(id);
	return id;
}

function _with_context(contextId, fn) {
	const prev = _current_memo_context_id;
	_current_memo_context_id = contextId;
	try {
		return fn();
	} finally {
		_current_memo_context_id = prev;
	}
}

function _with_mode_overrides(overrides, fn) {
	const base = _effective_context_entry(true).ctx;
	const contextId = ++_memo_context_counter;
	const ctx = _clone_context(base);
	ctx.modeOverrides = Object.freeze({
		...(base.modeOverrides || {}),
		...overrides,
	});
	_memo_contexts.set(contextId, ctx);
	return _with_context(contextId, fn);
}

function _is_object_key(value) {
	return (
		(typeof value === "object" && value !== null) || typeof value === "function"
	);
}

function _contextual_thenable(promise, contextId) {
	const nativePromise = Promise.resolve(promise);
	if (_is_object_key(nativePromise) && !_promise_contexts.has(nativePromise)) {
		_promise_contexts.set(nativePromise, contextId);
	}
	const wrap = (callback) => {
		if (typeof callback !== "function") return callback;
		return (value) => {
			return _with_js_lane(
				_context_owner(contextId),
				_context_label(contextId),
				() => _call_with_context(contextId, () => callback(value)),
			);
		};
	};
	return {
		then(onFulfilled, onRejected) {
			return _contextual_thenable(
				nativePromise.then(wrap(onFulfilled), wrap(onRejected)),
				contextId,
			);
		},
		catch(onRejected) {
			return this.then(undefined, onRejected);
		},
		finally(onFinally) {
			return _contextual_thenable(
				nativePromise.finally(
					typeof onFinally === "function"
						? () => _with_context(contextId, onFinally)
						: onFinally,
				),
				contextId,
			);
		},
	};
}

globalThis.__imp_promise_context_init = function (promise, parent) {
	if (!_is_object_key(promise)) return;
	const parentContext =
		_is_object_key(parent) && _promise_contexts.has(parent)
			? _promise_contexts.get(parent)
			: null;
	const contextId =
		_promise_context_override !== null
			? _promise_context_override
			: _current_memo_context_id !== 0
				? _current_memo_context_id
				: parentContext !== null && parentContext !== 0
					? parentContext
					: parentContext !== null
						? parentContext
						: _current_memo_context_id;
	_promise_contexts.set(promise, contextId);
};

globalThis.__imp_promise_context_before = function (promise) {
	_promise_context_stack.push(_current_memo_context_id);
	if (_is_object_key(promise) && _promise_contexts.has(promise)) {
		_current_memo_context_id = _promise_contexts.get(promise);
	}
};

globalThis.__imp_promise_context_after = function () {
	if (_promise_job_context_stack.length > 0) {
		_current_memo_context_id = _promise_job_context_stack.pop();
	}
	if (_promise_context_stack.length > 0) {
		_current_memo_context_id = _promise_context_stack.pop();
	}
	if (_promise_context_override_stack.length > 0) {
		_promise_context_override = _promise_context_override_stack.pop();
	}
};

function _emit_task(state, id, parent, label) {
	if (typeof globalThis.__host_task_event === "function") {
		globalThis.__host_task_event(
			state,
			id,
			parent === null ? undefined : parent,
			label,
		);
	}
}

function _active_memo_key() {
	const stack = _effective_context().stack;
	if (stack.length === 0) return null;
	return stack[stack.length - 1];
}

function _trace_effect(entry) {
	const owner = _active_memo_key();
	if (owner !== null) entry.owner = owner;
	_memo_trace.push(entry);
}

function _memo_label(key_string) {
	return _key_display.get(key_string) || key_string;
}

function _memo_cycle_message(key_string) {
	const stack = _effective_context().stack;
	const start = stack.indexOf(key_string);
	const cycle = (start >= 0 ? stack.slice(start) : stack.slice()).concat([
		key_string,
	]);
	const lines = [
		"memo cycle detected:",
		...cycle.map((key, index) => `  ${index + 1}. ${_memo_label(key)}`),
		"",
		"repeated key:",
		`  ${key_string}`,
	];
	return lines.join("\n");
}

function _memo_eval(key_string, owner, label, thunk) {
	// A concurrent branch that reaches the same in-flight memo must receive the
	// pending promise. A call from a context that already has this key on its
	// stack can still be a non-awaiting promise touch, so hits must win over
	// stack-cycle checks.
	if (_memo_table.has(key_string)) {
		_memo_trace.push({ event: "hit", key: key_string });
		return _memo_table.get(key_string);
	}
	if (_effective_context().stackSet.has(key_string)) {
		throw new Error(_memo_cycle_message(key_string));
	}
	_memo_trace.push({ event: "miss", key: key_string });
	// A fresh node for this evaluation, parented at the caller captured at the
	// call site. Created on miss only, so a memo appears once (concurrent
	// reusers just await it). The thunk runs when a cooperative JS lane is
	// available, but the promise is recorded first so queued duplicate callers
	// share the same work.
	const nodeId = ++_memo_node_counter;
	_memo_node_labels.set(nodeId, label);
	_emit_task("pending", nodeId, owner, label);
	const promise = _with_js_lane(nodeId, label, () => thunk(nodeId));
	_memo_table.set(key_string, promise);
	promise.then(
		() => _emit_task("done", nodeId, owner, label),
		(e) => _emit_task("fail", nodeId, owner, (e && e.message) || String(e)),
	);
	return promise;
}

function _push_call(key_string) {
	const ctx = _effective_context();
	if (ctx.stack.length > 0) {
		_memo_deps.push({
			caller: ctx.stack[ctx.stack.length - 1],
			callee: key_string,
		});
	}
	ctx.stack.push(key_string);
	ctx.stackSet.add(key_string);
}

function _pop_call(key_string, contextId) {
	const ctx = _memo_contexts.get(contextId);
	if (ctx === undefined) return;
	ctx.stack.pop();
	ctx.stackSet.delete(key_string);
	_active_memo_context_ids.delete(contextId);
	_memo_context_labels.delete(contextId);
}

/**
 * Register a memoized build function as a CLI-dispatchable product.
 *
 * Calling `product(kind, name, tool, fn)` is equivalent to `memo(fn)` plus
 * registering the result so that goal execution (e.g. `imp build
 * //:target#name`) dispatches to it when the target's kind matches.
 * Products are keyed `(kind, product, tool)`: several tools may register the
 * same product for one kind (e.g. two formatters), and goal dispatch runs
 * them all.
 *
 * @param {Function} kindClass Target subclass declaring `static kind`, e.g. OdinPackage.
 * @param {object} nameToken Product-name token from productName(), goal(), or
 *   a builtin export (BUILD, TEST, …) — never a bare string, so registering a
 *   name requires importing its declaring module.
 * @param {object} toolToken Tool-name token from toolName() or a toolchain
 *   class's `static tool` — the tool this registration attributes to in
 *   capability docs and multi-tool dispatch labels.
 * @param {function} fn Async function taking a target handle and returning a result.
 * @returns {function} The same function, wrapped in memo().
 */
export function product(kindClass, nameToken, toolToken, fn) {
	const kind = _kind_of(kindClass, "product()");
	const { name, pid } = _product_name_of(nameToken, "product()");
	const { name: tool, tid } = _tool_name_of(toolToken, "product()");
	const memoized = memo(fn);
	const registrationStack = new Error("product registration").stack || "";
	__host_product(
		JSON.stringify({ kind, name, nameId: pid, tool, toolId: tid }),
		memoized,
		registrationStack,
	);
	_product_fn_info.set(_stable_function_id(fn), name);
	let by_tool = _products_by_kind_name.get(`${kind}:${name}`);
	if (by_tool === undefined) {
		by_tool = new Map();
		_products_by_kind_name.set(`${kind}:${name}`, by_tool);
	}
	by_tool.set(tool, memoized);
	return memoized;
}

/**
 * Register a lazy target expander for a target kind: a rule can run a
 * discovery step (e.g. `cmake configure`) and mint additional, separately
 * addressable targets via `registerTarget()`, instead of flattening
 * everything it discovers into one target's attrs.
 *
 * Unlike `product()`, an expander isn't tied to a CLI-dispatchable name — the
 * engine invokes it lazily, at most once per invocation, for any
 * statically-declared target of this `kind` that's reachable from the
 * current goal's selection (see `ensure_expanded` in spike.rs). An optional
 * `{ goals: ["test", ...] }` scope limits expansion to those goals.
 *
 * @param {Function} kindClass Target subclass declaring `static kind`, e.g. CmakeLib.
 * @param {function} fn Async function taking the expanding target's handle;
 *   calls `registerTarget()` for each target it discovers.
 * @param {object} [opts] Optional goal scope for expanders that are only
 *   needed by a particular graph traversal, such as test-binary discovery.
 * @returns {function} The same function, wrapped in memo().
 */
export function expand(kindClass, fn, opts = {}) {
	const kind = _kind_of(kindClass, "expand()");
	const memoized = memo(fn);
	__host_register_expander(kind, memoized, opts.goals ?? null);
	return memoized;
}

/**
 * Give a target handle constructed inside an `expand()` callback an
 * explicit, stable address, making it addressable/selectable like any other
 * workspace target (e.g. `//third_party/mylib:sqlite3`).
 *
 * @param {object} handle A `Target` handle (as returned by `new Target(...)`).
 * @param {string} address Full target address, e.g. `//path/to/pkg:name`.
 * @returns {object} The same handle, for chaining.
 */
export function registerTarget(handle, address) {
	if (!handle || handle.__imp !== true) {
		throw new Error("registerTarget(handle, address) expects a Target handle");
	}
	__host_register_dynamic_target(handle.__id, address);
	return handle;
}

/**
 * Wrap an async function so repeated calls with identical arguments return the
 * cached result. Cycles in the call graph are detected and thrown as errors.
 * Call getMemoTrace() for hit/miss events and dependency edges.
 *
 * @param {function} fn Named async function to memoize.
 * @returns {function}
 */
export function memo(fn) {
	const fn_id = _stable_function_id(fn);
	function display_arg(arg) {
		if (arg && arg.__imp === true) {
			try {
				return targetAddress(arg);
			} catch (_) {
				return "#" + arg.__id;
			}
		}
		return JSON.stringify(arg);
	}
	return function memoized(...args) {
		const unwrapped = args.length > 0 ? _unwrap_dep_edge(args[0]) : null;
		const hasProfile = !!(unwrapped?.profiles && unwrapped.profiles.length > 0);
		const callArgs = unwrapped ? [unwrapped.handle, ...args.slice(1)] : args;
		const key_string = JSON.stringify({
			fn_id,
			args_digest: _stable_digest(args),
			config_digest: __host_configuration_digest(undefined, undefined),
		});
		if (!_key_display.has(key_string)) {
			const label = fn.name + "(" + args.map(display_arg).join(", ") + ")";
			_key_display.set(key_string, label);
			const product_name = _product_fn_info.get(fn_id);
			if (
				product_name !== undefined &&
				args.length > 0 &&
				args[0] !== null &&
				typeof args[0] === "object" &&
				args[0].__imp === true
			) {
				_key_product_call.set(key_string, {
					target_id: args[0].__id,
					product_name,
				});
			}
		}
		const label = _key_display.get(key_string) || key_string;
		const callerContext = _effective_context_entry(true);
		const callerContextId = callerContext.id;
		const owner = callerContext.ctx.owner;
		return _contextual_thenable(
			_memo_eval(key_string, owner, label, (nodeId) => {
				const childContextId = _fork_context(nodeId, callerContext.ctx, label);
				return _with_context(childContextId, () => {
					_emit_task("running", nodeId, owner, label);
					_push_call(key_string);
					let promise;
					try {
						promise = hasProfile
							? _with_mode_overrides(unwrapped.modeOverrides, () =>
									Promise.resolve(fn(...callArgs)),
								)
							: Promise.resolve(fn(...callArgs));
					} catch (e) {
						_pop_call(key_string, childContextId);
						throw e;
					}
					if (_is_object_key(promise)) {
						_promise_contexts.set(promise, childContextId);
					}
					promise.then(
						() => _pop_call(key_string, childContextId),
						() => _pop_call(key_string, childContextId),
					);
					return promise;
				});
			}),
			callerContextId,
		);
	};
}

/**
 * Reset all memo state. Call between test runs to start with a clean slate.
 * Does NOT reset function identity — the same function reference always maps
 * to the same ID even across resets.
 */
export function resetMemoState() {
	_memo_table = new Map();
	_memo_deps = [];
	_memo_trace = [];
	_key_display = new Map();
	_key_product_call = new Map();
	_memo_context_counter = 0;
	_current_memo_context_id = 0;
	_memo_contexts = new Map([
		[
			0,
			{
				owner: null,
				stack: [],
				stackSet: new Set(),
				readNamespaces: new Set(),
				modeOverrides: null,
			},
		],
	]);
	_active_memo_context_ids = new Set();
	_promise_contexts = new WeakMap();
	_promise_context_stack = [];
	_promise_job_context_stack = [];
	_promise_context_override = null;
	_promise_context_override_stack = [];
	_memo_node_counter = 0;
	_memo_node_labels = new Map();
	_memo_context_labels = new Map([[0, ""]]);
	_reset_js_lanes();
}

/**
 * Return a snapshot of the memo trace and dependency graph.
 * @returns {{ trace: Array, deps: Array, key_display: Object, key_product_calls: Object }}
 */
export function getMemoTrace() {
	return {
		trace: _memo_trace.slice(),
		deps: _memo_deps.slice(),
		key_display: Object.fromEntries(_key_display),
		key_product_calls: Object.fromEntries(_key_product_call),
	};
}

// ---------------------------------------------------------------------------
// Tracked runtime APIs (Phase 3)
// ---------------------------------------------------------------------------

// glob() returns a lazy FileSet descriptor — no I/O happens here.
// Call paths(fileset) to evaluate it.
export function glob(opts) {
	if (!opts || !Array.isArray(opts.include)) {
		throw new Error(
			"glob({ root?, include, exclude? }) requires include glob patterns",
		);
	}
	return {
		__fileset: true,
		kind: "glob",
		root: opts.root || ".",
		include: opts.include,
		exclude: opts.exclude || [],
	};
}

// ---------------------------------------------------------------------------
// FileSet — lazy file collection (Phase 4)
// ---------------------------------------------------------------------------

// Evaluates a FileSet to { files, digest }. `digest` is an opaque hex-string CAS
// handle (never a serialized tree) that composes uniformly across glob/union/
// literal — union merges child digests server-side rather than deriving one from
// the flattened path list. Memoized onto the FileSet object itself: root/include/
// exclude (or a literal path list) are immutable inputs, so repeat evaluation
// (e.g. paths() followed by using the same FileSet in run({inputs})) is free.
function _eval_fileset(fs) {
	if (!fs || fs.__fileset !== true)
		throw new Error("paths() requires a FileSet");
	if (fs.__digest !== undefined) {
		return { files: fs.__files, digest: fs.__digest };
	}
	let result;
	if (fs.kind === "glob") {
		const parsed = JSON.parse(
			__host_glob(
				fs.root,
				JSON.stringify(fs.include),
				JSON.stringify(fs.exclude),
			),
		);
		result = { files: parsed.files, digest: parsed.digest };
	} else if (fs.kind === "union") {
		const seen = new Set();
		const all = [];
		const digests = [];
		for (const s of fs.sets) {
			const evaluated = _eval_fileset(s);
			digests.push(evaluated.digest);
			for (const p of evaluated.files) {
				if (!seen.has(p)) {
					seen.add(p);
					all.push(p);
				}
			}
		}
		all.sort();
		result = {
			files: all,
			digest: __host_merge_digests(JSON.stringify(digests)),
		};
	} else if (fs.kind === "literal") {
		const sortedPaths = fs.paths.slice().sort();
		result = {
			files: sortedPaths,
			digest: __host_capture_paths(JSON.stringify(sortedPaths)),
		};
	} else {
		throw new Error("paths(): unsupported FileSet kind: " + fs.kind);
	}
	fs.__files = result.files;
	fs.__digest = result.digest;
	return result;
}

export function paths(fileset) {
	if (!fileset || fileset.__fileset !== true) {
		throw new Error("paths() requires a FileSet value");
	}
	const result = _eval_fileset(fileset).files;
	_trace_effect({
		event: "effect",
		kind: "paths",
		fileset_kind: fileset.kind,
		count: result.length,
	});
	return result;
}

/**
 * The merged tree digest backing a FileSet, e.g. to diff against a later
 * run()'s outputDigest via diffDigests() — the digest is already computed
 * and cached by _eval_fileset, this just exposes it.
 *
 * @param {object} fileset A FileSet value (e.g. from own_sources()).
 * @returns {string} Digest string.
 */
export function digestOf(fileset) {
	if (!fileset || fileset.__fileset !== true) {
		throw new Error("digestOf() requires a FileSet value");
	}
	return _eval_fileset(fileset).digest;
}

/**
 * Structurally diff two digests (e.g. a FileSet's digest before a run()
 * against that run()'s outputDigest after), without needing either tree
 * materialized on disk.
 *
 * @param {string} before Digest string.
 * @param {string} after Digest string.
 * @returns {Array<{type: "added"|"removed"|"modified", path: string}>}
 */
export function diffDigests(before, after) {
	return JSON.parse(__host_diff_digests(before, after));
}

/**
 * List every file path within a digest's tree, e.g. to inspect what a
 * run()'s outputDigest or a FileSet's digest (via digestOf()) actually
 * contains, without materializing it to disk.
 *
 * @param {string} digest Digest string.
 * @returns {string[]}
 */
export function pathsInDigest(digest) {
	return JSON.parse(__host_digest_paths(digest));
}

/**
 * Aggregate file count and total byte size of a digest's tree (optionally
 * narrowed to the entry at `from`, resolved the same way writeWorkspace()
 * resolves its `opts.from`) — lets a caller report what a digest contains
 * without materializing it to disk.
 *
 * @param {string} digest Digest string.
 * @param {string} [from] Path within `digest` to narrow to.
 * @returns {{fileCount: number, totalSize: number}}
 */
export function digestStat(digest, from) {
	return JSON.parse(__host_digest_stat(digest, from ?? null));
}

/**
 * Read a single file's content out of a digest's tree by its relative path —
 * the digest-backed analog of read_file() for the real workspace.
 *
 * @param {string} digest Digest string.
 * @param {string} path Relative path within the tree.
 * @returns {string}
 */
export function readFileInDigest(digest, path) {
	return __host_digest_read_file(digest, path);
}

/**
 * Materialize `digest` (optionally narrowed to the entry at `opts.from`)
 * directly into the workspace at `path` — no sandbox, no cache record, no
 * process spawn. This is the one blessed way to publish a final digest under
 * dist/, bypassing run()'s materialize:true path (and its warning) entirely.
 * The `package` goal (rules/workflows/package.js) is its only caller today —
 * package products themselves just describe what to publish via artifact(),
 * they don't call this directly.
 *
 * `opts.from` may resolve to a directory (published wholesale at `path`,
 * replacing whatever was there — the dist/ package pattern) or to an
 * individual file/symlink (published at exactly `path`, leaving sibling
 * paths untouched — e.g. publishing one declared `run()` file output next to
 * hand-written files in the same directory).
 *
 * @param {string} path Workspace-relative destination path.
 * @param {string} digest Digest string (e.g. a run()'s outputDigest).
 * @param {object} [opts]
 * @param {string} [opts.from] Path within `digest` to write, stripping its
 *   prefix — e.g. a run() output's declared output_path.
 * @returns {void}
 */
export function writeWorkspace(path, digest, opts) {
	const contextEntry = _effective_context_entry(true);
	_trace_effect_in_context(
		{ event: "effect", kind: "write_workspace", path },
		contextEntry.ctx,
	);
	return __host_write_workspace(path, digest, (opts && opts.from) ?? null);
}

/**
 * Construct the container a `package` product returns: a digest plus the
 * (optional) subtree path within it to publish. Package products describe
 * what to publish — the `package` goal (rules/workflows/package.js) is the
 * only thing that actually materializes it (via writeWorkspace) and reports
 * on it (via digestStat).
 *
 * @param {string} digest Digest string (e.g. a build product's outputDigest).
 * @param {object} [opts]
 * @param {string} [opts.from] Path within `digest` to publish, stripping its
 *   prefix — mirrors writeWorkspace()'s `opts.from`.
 * @returns {{digest: string, from: string|null}}
 */
export function artifact(digest, opts) {
	if (!digest || typeof digest !== "string") {
		throw new Error(
			"artifact(digest, opts?) requires a non-empty digest string",
		);
	}
	return { digest, from: (opts && opts.from) ?? null, __imp_artifact: true };
}

/**
 * Render and — unless `opts.check` — write a set of generated BUILD.js file
 * edits into the real workspace. The JS-callable entry point for the
 * generate-build renderer (import merging, preserving hand-written exports)
 * that `registerBuildRule()`-declared rules feed into; never throws on stale
 * files itself, callers decide what a check failure means.
 *
 * @param {object} opts
 * @param {Record<string, Array<{name: string, rule: string, props?: object}>>} opts.edits
 *   Map of workspace-relative BUILD.js path → targets to render into it.
 * @param {boolean} opts.check Compute the diff without writing.
 * @returns {{changed: string[], checked: string[]}}
 */
export function applyBuildEdits({ edits, check }) {
	const contextEntry = _effective_context_entry(true);
	if (!check) {
		_trace_effect_in_context(
			{ event: "effect", kind: "apply_build_edits" },
			contextEntry.ctx,
		);
	}
	return JSON.parse(__host_apply_build_edits(JSON.stringify(edits), !!check));
}

/**
 * Merge multiple digests (each already a directory tree — e.g. several
 * run() outputs, each nested under its own declared output path) into one
 * combined tree digest. The digest-chaining analog of file_set.union() for
 * run() outputs rather than glob results — lets a later run() take
 * `{ kind: "digest", digest }` as an input instead of depending on an
 * earlier step's output being physically materialized in the workspace.
 *
 * @param {string[]} digests
 * @returns {string} Merged digest string.
 */
export function mergeDigests(digests) {
	return __host_merge_digests(JSON.stringify(digests));
}

export const file_set = {
	union(...sets) {
		for (const s of sets) {
			if (!s || s.__fileset !== true)
				throw new Error("file_set.union() requires FileSet values");
		}
		return { __fileset: true, kind: "union", sets };
	},
	literal(file_paths) {
		if (!Array.isArray(file_paths))
			throw new Error("file_set.literal() requires an array of paths");
		return { __fileset: true, kind: "literal", paths: file_paths };
	},
};

// Reduce any FileSet objects in an inputs array to a single {kind:"digest"} entry
// each (its already-merged tree digest, staged directly from CAS — see exec.rs),
// rather than one {kind:"file"} entry per matched file. Plain {kind, path} objects
// (e.g. from output(), or a prior run()'s outputDigest wrapped as {kind:"digest"})
// are passed through unchanged.
function _materialise_inputs(inputs) {
	const result = [];
	for (const input of inputs || []) {
		if (input && input.__fileset === true) {
			const { files, digest } = _eval_fileset(input);
			_trace_effect({
				event: "effect",
				kind: "paths",
				fileset_kind: input.kind,
				count: files.length,
			});
			result.push({ kind: "digest", digest });
		} else if (input != null) {
			result.push(input);
		}
	}
	return result;
}

export function output(path, opts) {
	return {
		kind: (opts && opts.kind) || "file",
		path,
		...(opts && opts.namedCache ? { namedCache: opts.namedCache } : {}),
	};
}

export function output_path(path) {
	if (typeof path !== "string" || path.length === 0) {
		throw new Error("output_path(path) requires a non-empty string");
	}
	return path;
}

export function env(name) {
	const result = __host_env(name);
	_trace_effect({ event: "effect", kind: "env", name, result });
	return result ?? null;
}

export function which(name) {
	const result = __host_which(name);
	_trace_effect({ event: "effect", kind: "which", name, result });
	return result ?? null;
}

export function nativeToolArtifact(name) {
	const result = __host_native_tool_artifact(name);
	_trace_effect({ event: "effect", kind: "nativeToolArtifact", name, result });
	return result;
}

export function read_file(path) {
	const result = __host_read_file(path);
	_trace_effect({ event: "effect", kind: "read_file", path });
	return result;
}

/**
 * Read a workspace-addressed data file (`//path/to/file`) — workspace root
 * first, then the built-in rules tree for `//rules/...` addresses, the same
 * precedence module imports use. Returns null when no source has the file.
 *
 * @param {string} address
 * @returns {string|null}
 */
export function readAddressedFile(address) {
	const result = __host_read_addressed_file(address);
	_trace_effect({ event: "effect", kind: "read_addressed_file", address });
	return result ?? null;
}

function _trace_effect_in_context(entry, ctx) {
	const stack = ctx.stack;
	if (stack.length > 0) entry.owner = stack[stack.length - 1];
	_memo_trace.push(entry);
}

// run()'s own single-flight: bare promise-coalescing for concurrent calls
// with byte-identical host payloads, with none of memo()'s task-tree nodes,
// cycle detection, or dependency-edge bookkeeping — run() isn't a build
// function, it's the primitive every build function bottoms out in, so
// giving every call its own memo node would double the UI/graph overhead for
// no benefit.
//
// Exists to close a real race (#11): the Rust task cache checks for an
// existing record, executes on a miss, then writes the record — with no
// lock between check and write. Two concurrent run() calls sharing a
// task-cache key (e.g. rules/rust/test.js's buildTestBinaries, called by
// both the test-binary discovery expander and each generated target's own
// build product) can both observe a miss and both execute in separate
// sandboxes, and whichever writes its record last silently wins, stranding
// the other caller's outputs. JS is single-runtime and only yields at
// `await` (see scheduler.rs), so the check-then-store below is one
// uninterruptible turn — unlike the Rust side, there is no window for two
// callers to both miss.
//
// Only entries for cacheable calls are tracked, matching the Rust cache's
// own gate (`!impure || forceCache`): impure/no-cache calls are meant to
// re-execute every time by design (non-idempotent side effects), so they
// always bypass this table and call the host directly. Entries are deleted
// the moment their promise settles — this is single-flight, not memoization;
// a later, non-overlapping call always goes back through the host (which
// will itself hit the on-disk task cache on a cache hit).
let _run_inflight = new Map();

function _run_single_flight_key(hostPayload) {
	// __owner identifies the calling memo node purely for the task-tree's
	// UI parent attribution (see spike.rs's `__owner` → job `parent`) — it
	// is not part of Rust's action/task digest, and two calls that are
	// otherwise identical routinely come from different callers (that's
	// exactly the race this exists to close). Every other field does affect
	// either real behavior (e.g. allowFailure, materialize) or Rust's own
	// digest (e.g. display), so it stays in the key.
	const { __owner, ...keyed } = hostPayload;
	return JSON.stringify(keyed);
}

function _run_dispatch(hostPayload, cacheable) {
	if (!cacheable) return __host_run(hostPayload);
	const key = _run_single_flight_key(hostPayload);
	const inflight = _run_inflight.get(key);
	if (inflight) return inflight;
	const promise = __host_run(hostPayload).finally(() => {
		_run_inflight.delete(key);
	});
	_run_inflight.set(key, promise);
	return promise;
}

export function run(opts) {
	const contextEntry = _effective_context_entry(true);
	const inputs = _materialise_inputs(opts.inputs);
	const outputs = opts.outputs ?? [];
	if (
		outputs.length > 0 &&
		opts.materialize !== true &&
		opts.materialize !== false
	) {
		throw new Error(
			"run(): materialize must be explicitly set (true or false) when outputs are declared",
		);
	}
	const materialize = opts.materialize ?? true;
	const effect = {
		event: "effect",
		kind: "run",
		display: opts.display ?? (opts.argv && opts.argv[0]),
		argv: opts.argv ?? [],
		env: opts.env ?? [],
		inputs,
		outputs,
		tools: opts.tools ?? [],
		impure: opts.impure === true,
		forceCache: opts.forceCache === true,
		sandbox: opts.sandbox !== false,
		workspaceCwd: opts.workspaceCwd === true,
		allowFailure: opts.allowFailure === true,
		materialize,
		stream: opts.stream === true,
	};
	_trace_effect_in_context(effect, contextEntry.ctx);
	const contextId = contextEntry.id;
	const owner = contextEntry.ctx.owner;
	const hostPayload = {
		argv: opts.argv,
		display: opts.display,
		env: opts.env,
		configDigest: __host_configuration_digest(
			JSON.stringify(Array.from(contextEntry.ctx.readNamespaces)),
			JSON.stringify(contextEntry.ctx.modeOverrides || {}),
		),
		inputs,
		outputs,
		tools: opts.tools,
		impure: opts.impure,
		forceCache: opts.forceCache,
		sandbox: opts.sandbox,
		workspaceCwd: opts.workspaceCwd,
		allowFailure: opts.allowFailure,
		materialize,
		stream: opts.stream,
		__owner: owner,
	};
	// Mirrors exec.rs's own cacheable gate exactly: impure calls are meant to
	// re-execute every time and must never single-flight onto another call.
	const cacheable = !effect.impure || effect.forceCache;
	const promise = _run_dispatch(hostPayload, cacheable).then((result) => ({
		...result,
		outputs,
	}));
	return _contextual_thenable(promise, contextId);
}

/**
 * Describe a program that the `run` goal will execute. A run product returns
 * one of these instead of calling run() itself, leaving goal-wide policy
 * (sandboxing, working directory, impurity, and CLI arguments) in one place.
 *
 * @param {object} opts The run() options owned by the product.
 * @returns {object} An opaque run template.
 */
export function runTemplate(opts) {
	if (!opts || typeof opts !== "object" || !Array.isArray(opts.argv)) {
		throw new Error("runTemplate({ argv, ... }) requires an argv array");
	}
	return Object.freeze({
		__impRunTemplate: true,
		opts: Object.freeze({ ...opts, argv: [...opts.argv] }),
	});
}

/**
 * Execute a runTemplate with policy supplied by the run workflow.
 * `args` are appended to the template argv rather than replacing it.
 *
 * @param {object} template A value returned by runTemplate().
 * @param {object} policy Goal-owned run() options plus optional `args`.
 * @returns {Promise<object>} Run result.
 */
export function runFromTemplate(template, policy = {}) {
	if (!template || template.__impRunTemplate !== true || !template.opts) {
		throw new Error("run goal product must return runTemplate({ argv, ... })");
	}
	if (!Array.isArray(policy.args ?? [])) {
		throw new Error("runFromTemplate(..., { args }) requires an array");
	}
	const { args = [], ...runPolicy } = policy;
	return run({
		...template.opts,
		...runPolicy,
		argv: [...template.opts.argv, ...args],
	});
}

export function group(items) {
	if (!Array.isArray(items)) {
		throw new Error("group(items) requires an array");
	}
	const contextEntry = _effective_context_entry(true);
	_trace_effect_in_context(
		{ event: "effect", kind: "group", count: items.length },
		contextEntry.ctx,
	);
	return _contextual_thenable(Promise.all(items), contextEntry.id);
}

export function workspace_mutation(opts) {
	const contextEntry = _effective_context_entry(true);
	const trace_entry = {
		event: "effect",
		kind: "workspace_mutation",
		display: opts.display ?? (opts.argv && opts.argv[0]),
	};
	_trace_effect_in_context(trace_entry, contextEntry.ctx);
	const contextId = contextEntry.id;
	const owner = contextEntry.ctx.owner;
	return _contextual_thenable(
		__host_workspace_mutation({ ...opts, __owner: owner }).then((result) => {
			if (result.changed_files !== undefined) {
				trace_entry.changed_files = result.changed_files;
			}
			return result;
		}),
		contextId,
	);
}

// Handle registry: maps numeric js_id → enriched handle for product function dispatch.
globalThis.__imp_handle_by_id = new Map();
globalThis.__imp_resolve_handle = function (id) {
	return globalThis.__imp_handle_by_id.get(id);
};
// Expose memo-state helpers as globals so Rust can call them without module imports.
globalThis.resetMemoState = resetMemoState;
globalThis.getMemoTrace = getMemoTrace;

function _fmt(...args) {
	return args
		.map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
		.join(" ");
}
export function logDebug(...args) {
	__host_log("debug", _fmt(...args));
}
export function logInfo(...args) {
	__host_log("info", _fmt(...args));
}
export function logWarn(...args) {
	__host_log("warn", _fmt(...args));
}
export function logError(...args) {
	__host_log("error", _fmt(...args));
}

/** Path to the currently running imp executable. Use as the first element of
 *  an odinGen `cmd` to invoke imp subcommands as generators. */
export const imp_self = globalThis.__imp_self_bin || "imp";
