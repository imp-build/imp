import {
	BUILD,
	PACKAGE,
	PUBLISH,
	files,
	output,
	packagePath,
	task,
} from "imp:core";

import { nativeTool } from "//rules/imp/native-tool";
import { craneGraphTool } from "//rules/oci/toolchain";

export {
	craneToolchain,
	defaultCraneToolchain,
	defaultCraneToolchainVersion,
	resolveCraneToolchainVersion,
} from "//rules/oci/toolchain";

function normalizeWorkspacePath(path) {
	const parts = [];
	for (const part of path.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			throw new Error(`OCI paths must stay within the workspace: ${path}`);
		}
		parts.push(part);
	}
	return parts.length === 0 ? "." : parts.join("/");
}

function declaredWorkspacePath(base, path = ".") {
	const local = path || ".";
	if (base === ".") return normalizeWorkspacePath(local);
	if (local === ".") return normalizeWorkspacePath(base);
	return normalizeWorkspacePath(`${base}/${local}`);
}

function registryHost(repo) {
	const first = repo.split("/")[0];
	return first.includes(".") || first.includes(":") || first === "localhost"
		? first
		: "index.docker.io";
}

function imageOf(value, api) {
	if (
		!value ||
		!value.image ||
		!value.image.layout ||
		value.image.digest === undefined
	) {
		throw new Error(`${api} requires an ociPull()/ociBuild() image object`);
	}
	return value.image;
}

function resolveTagDigest({ repo, tag, crane }) {
	return task({
		display: `resolve ${repo}:${tag}`,
		inputs: { repo, tag, crane },
		outputs: { digest: output.value() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					exec.tool(inputs.crane, "crane"),
					"digest",
					`${inputs.repo}:${inputs.tag}`,
				],
				cache: false,
			});
			return { digest: result.stdout.trim() };
		},
	}).outputs.digest;
}

function pullLayout({ repo, digest, crane }) {
	return task({
		display: `pull ${repo}`,
		inputs: { repo, digest, crane },
		outputs: { layout: output.artifact() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					exec.tool(inputs.crane, "crane"),
					"pull",
					"--format=oci",
					`${inputs.repo}@${inputs.digest}`,
					"oci-layout",
				],
				outputs: { layout: output.directory("oci-layout") },
			});
			return { layout: result.outputs.layout };
		},
	}).outputs.layout;
}

function layerTarball({ source, root, layer, index }) {
	const shell = nativeTool("sh");
	const mkdir = nativeTool("mkdir");
	const dirname = nativeTool("dirname");
	const cp = nativeTool("cp");
	const tar = nativeTool("tar");
	const chmod = nativeTool("chmod");
	const destination = layer.path.replace(/^\/+|\/+$/g, "");
	return task({
		display: `stage OCI layer ${index} (${layer.path})`,
		inputs: {
			source,
			root,
			destination,
			mode: layer.mode ? String(layer.mode) : "",
			uid: String(layer.uid ?? 0),
			gid: String(layer.gid ?? 0),
			shell,
			mkdir,
			dirname,
			cp,
			tar,
			chmod,
		},
		outputs: { tarball: output.artifact() },
		async run(exec, inputs) {
			const sourcePaths = exec.paths(inputs.source);
			if (sourcePaths.length === 0) {
				throw new Error(`ociBuild layer ${index}: no files matched 'srcs'`);
			}
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'root=$1; stage=$2; out=$3; dest=$4; mode=$5; uid=$6; gid=$7; shift 7; prefix=""; if [ "$root" != "." ]; then prefix="$root/"; fi; mkdir -p "$stage/$dest"; for f in "$@"; do rel="${f#$prefix}"; target="$stage/$dest/$rel"; mkdir -p "$(dirname "$target")"; cp "$f" "$target"; if [ -n "$mode" ]; then chmod "$mode" "$target"; fi; done; tar --sort=name --mtime="@0" --owner="$uid" --group="$gid" --numeric-owner -C "$stage" -cf "$out" .',
					"oci-layer-tar",
					inputs.root,
					"layer-stage",
					"layer.tar",
					inputs.destination,
					inputs.mode,
					inputs.uid,
					inputs.gid,
					...sourcePaths,
				],
				tools: [
					inputs.shell,
					inputs.mkdir,
					inputs.dirname,
					inputs.cp,
					inputs.tar,
					inputs.chmod,
				],
				outputs: { tarball: output.file("layer.tar") },
			});
			return { tarball: result.outputs.tarball };
		},
	}).outputs.tarball;
}

const COMPOSE_OCI_IMAGE_SCRIPT = [
	"out=$1; base=$2; entrypoint=$3; cmd=$4; envList=$5; labels=$6; user=$7; workdir=$8",
	"shift 8",
	'mkdir -p "$out/blobs/sha256"',
	'if [ -n "$base" ]; then',
	'  cp -r "$base/." "$out/"',
	'  manifest_digest=$(jq -r ".manifests[0].digest" "$out/index.json" | cut -d: -f2)',
	'  manifest_path="$out/blobs/sha256/$manifest_digest"',
	'  config_digest=$(jq -r ".config.digest" "$manifest_path" | cut -d: -f2)',
	'  config_json=$(cat "$out/blobs/sha256/$config_digest")',
	'  layers_json=$(jq -c ".layers" "$manifest_path")',
	"else",
	'  echo \'{"imageLayoutVersion":"1.0.0"}\' > "$out/oci-layout"',
	'  config_json=$(jq -n -c \'{architecture:"amd64",os:"linux",config:{},rootfs:{type:"layers",diff_ids:[]},history:[]}\')',
	"  layers_json='[]'",
	"fi",
	'for tarball in "$@"; do',
	'  digest=$(sha256sum "$tarball" | cut -d" " -f1)',
	'  size=$(wc -c < "$tarball")',
	'  cp "$tarball" "$out/blobs/sha256/$digest"',
	'  config_json=$(printf "%s" "$config_json" | jq -c --arg d "sha256:$digest" \' .rootfs.diff_ids += [$d] | .history += [{"created":"1970-01-01T00:00:00Z","created_by":"imp oci-build"}] \')',
	'  layers_json=$(printf "%s" "$layers_json" | jq -c --arg d "sha256:$digest" --argjson size "$size" \'. + [{mediaType:"application/vnd.oci.image.layer.v1.tar",digest:$d,size:$size}]\')',
	"done",
	'config_json=$(printf "%s" "$config_json" | jq -S -c --argjson entrypoint "$entrypoint" --argjson cmd "$cmd" --argjson envList "$envList" --argjson labels "$labels" --arg user "$user" --arg workdir "$workdir" \' (if ($entrypoint | length) > 0 then .config.Entrypoint = $entrypoint else . end) | (if ($cmd | length) > 0 then .config.Cmd = $cmd else . end) | (if ($envList | length) > 0 then .config.Env = $envList else . end) | (if ($labels | length) > 0 then .config.Labels = ((.config.Labels // {}) * $labels) else . end) | (if $user != "" then .config.User = $user else . end) | (if $workdir != "" then .config.WorkingDir = $workdir else . end) \')',
	'config_digest=$(printf "%s" "$config_json" | sha256sum | cut -d" " -f1)',
	'printf "%s" "$config_json" > "$out/blobs/sha256/$config_digest"',
	'config_size=$(wc -c < "$out/blobs/sha256/$config_digest")',
	'manifest_json=$(jq -n -c --arg cd "sha256:$config_digest" --argjson cs "$config_size" --argjson layers "$layers_json" \'{schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",config:{mediaType:"application/vnd.oci.image.config.v1+json",digest:$cd,size:$cs},layers:$layers}\' | jq -S -c .)',
	'manifest_digest=$(printf "%s" "$manifest_json" | sha256sum | cut -d" " -f1)',
	'printf "%s" "$manifest_json" > "$out/blobs/sha256/$manifest_digest"',
	'manifest_size=$(wc -c < "$out/blobs/sha256/$manifest_digest")',
	'index_json=$(jq -n -c --arg md "sha256:$manifest_digest" --argjson ms "$manifest_size" \'{schemaVersion:2,mediaType:"application/vnd.oci.image.index.v1+json",manifests:[{mediaType:"application/vnd.oci.image.manifest.v1+json",digest:$md,size:$ms,platform:{architecture:"amd64",os:"linux"}}]}\' | jq -S -c .)',
	'printf "%s" "$index_json" > "$out/index.json"',
	'printf "sha256:%s" "$manifest_digest"',
].join("\n");

function composeImage({ base, layers, config }) {
	const inputs = {
		base: base?.layout ?? null,
		entrypoint: config.entrypoint ?? [],
		cmd: config.cmd ?? [],
		envList: Object.entries(config.env ?? {}).map(
			([key, value]) => `${key}=${value}`,
		),
		labels: config.labels ?? {},
		user: config.user ?? "",
		workdir: config.workdir ?? "",
		shell: nativeTool("sh"),
		jq: nativeTool("jq"),
		sha256sum: nativeTool("sha256sum"),
		cp: nativeTool("cp"),
		mkdir: nativeTool("mkdir"),
		wc: nativeTool("wc"),
		cut: nativeTool("cut"),
		cat: nativeTool("cat"),
		layerNames: [],
	};
	for (const [index, layer] of layers.entries()) {
		const name = `layer${index}`;
		inputs[name] = layer;
		inputs.layerNames.push(name);
	}
	return task({
		display: "compose OCI image",
		inputs,
		outputs: { layout: output.artifact(), digest: output.value() },
		async run(exec, resolved) {
			const layerPaths = resolved.layerNames.map((name) =>
				exec.path(resolved[name]),
			);
			const basePath = resolved.base ? exec.path(resolved.base) : "";
			const result = await exec.action({
				argv: [
					exec.tool(resolved.shell, "sh"),
					"-c",
					COMPOSE_OCI_IMAGE_SCRIPT,
					"oci-compose",
					"image",
					basePath,
					JSON.stringify(resolved.entrypoint),
					JSON.stringify(resolved.cmd),
					JSON.stringify(resolved.envList),
					JSON.stringify(resolved.labels),
					resolved.user,
					resolved.workdir,
					...layerPaths,
				],
				tools: [
					resolved.shell,
					resolved.jq,
					resolved.sha256sum,
					resolved.cp,
					resolved.mkdir,
					resolved.wc,
					resolved.cut,
					resolved.cat,
				],
				outputs: { layout: output.directory("image") },
			});
			return { layout: result.outputs.layout, digest: result.stdout.trim() };
		},
	});
}

function packageLayout(layout) {
	const shell = nativeTool("sh");
	const mkdir = nativeTool("mkdir");
	const tar = nativeTool("tar");
	return task({
		display: "package OCI archive",
		inputs: { layout, shell, mkdir, tar },
		outputs: { archive: output.artifact() },
		async run(exec, inputs) {
			const result = await exec.action({
				argv: [
					exec.tool(inputs.shell, "sh"),
					"-c",
					'mkdir -p "$1" && tar --sort=name --mtime="@0" --owner=0 --group=0 --numeric-owner -C "$2" -cf "$1/image.tar" .',
					"oci-package",
					"package",
					exec.path(inputs.layout),
				],
				tools: [inputs.shell, inputs.mkdir, inputs.tar],
				outputs: { archive: output.directory("package") },
			});
			return { archive: result.outputs.archive };
		},
	}).outputs.archive;
}

/** Declare an immutable OCI pull graph. */
export function ociPull({ repo, tag, digest }) {
	if (!repo) throw new Error("ociPull requires 'repo'");
	if (!tag === !digest) {
		throw new Error("ociPull requires exactly one of 'tag' or 'digest'");
	}
	const crane = craneGraphTool();
	const resolvedDigest = digest ?? resolveTagDigest({ repo, tag, crane });
	const layout = pullLayout({ repo, digest: resolvedDigest, crane });
	return Object.freeze({
		image: Object.freeze({ layout, digest: resolvedDigest }),
		[BUILD]: layout,
		[PACKAGE]: packageLayout(layout),
	});
}

/** Declare a deterministic single-platform OCI image build graph. */
export function ociBuild({
	path = ".",
	base,
	layers = [],
	entrypoint,
	cmd,
	env = {},
	labels = {},
	user,
	workdir,
	sourceBase = packagePath(),
}) {
	if (base !== "scratch") imageOf(base, "ociBuild's 'base'");
	if (!Array.isArray(layers) || layers.length === 0) {
		throw new Error("ociBuild requires one or more 'layers'");
	}
	const tarballs = layers.map((layer, index) => {
		if (!layer || !Array.isArray(layer.srcs) || layer.srcs.length === 0) {
			throw new Error(`ociBuild layer ${index} requires non-empty 'srcs'`);
		}
		if (!layer.path) {
			throw new Error(`ociBuild layer ${index} requires 'path'`);
		}
		const root = declaredWorkspacePath(sourceBase, path);
		return layerTarball({
			source: files({
				root,
				include: layer.srcs,
				exclude: layer.exclude || [],
			}),
			root,
			layer,
			index,
		});
	});
	const build = composeImage({
		base: base === "scratch" ? null : base.image,
		layers: tarballs,
		config: { entrypoint, cmd, env, labels, user, workdir },
	});
	return Object.freeze({
		image: Object.freeze({
			layout: build.outputs.layout,
			digest: build.outputs.digest,
		}),
		[BUILD]: build.outputs.layout,
		[PACKAGE]: packageLayout(build.outputs.layout),
	});
}

function publishImage({ image, repo, tag }) {
	const crane = craneGraphTool();
	return task({
		display: `push ${repo}:${tag}`,
		inputs: { layout: image.layout, crane, repo, tag },
		async run(exec, inputs) {
			await exec.action({
				argv: [
					exec.tool(inputs.crane, "crane"),
					"push",
					exec.path(inputs.layout),
					`${inputs.repo}:${inputs.tag}`,
				],
				cache: false,
			});
		},
	});
}

/** Declare an explicitly selected registry publication. */
export function ociPush({ image, repo, tag }) {
	const source = imageOf(image, "ociPush's 'image'");
	if (!repo) throw new Error("ociPush requires 'repo'");
	if (!tag) throw new Error("ociPush requires 'tag'");
	return Object.freeze({
		[PUBLISH]: publishImage({ image: source, repo, tag }),
	});
}

/** Declare an explicitly selected registry-to-registry copy. */
export function ociMirror({ from, to }) {
	if (!from || !from.repo || !(from.tag || from.digest)) {
		throw new Error("ociMirror requires 'from: { repo, tag|digest }'");
	}
	if (!to || !to.repo || !to.tag) {
		throw new Error("ociMirror requires 'to: { repo, tag }'");
	}
	const crane = craneGraphTool();
	const source = from.digest
		? `${from.repo}@${from.digest}`
		: `${from.repo}:${from.tag}`;
	const destination = `${to.repo}:${to.tag}`;
	return Object.freeze({
		[PUBLISH]: task({
			display: `mirror ${source} -> ${destination}`,
			inputs: {
				crane,
				source,
				destination,
				sourceRegistry: registryHost(from.repo),
				destinationRegistry: registryHost(to.repo),
			},
			async run(exec, inputs) {
				await exec.action({
					argv: [
						exec.tool(inputs.crane, "crane"),
						"copy",
						inputs.source,
						inputs.destination,
					],
					cache: false,
				});
			},
		}),
	});
}
