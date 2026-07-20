import { describe, expect, test } from "//rules/imp/test";
import {
	Target,
	field,
	product,
	BUILD,
	toolName,
	target,
	targetSchemas,
} from "imp:core";

const WIDGET_TOOL = toolName("target-schema-test-widget");

class Widget extends Target {
	static kind = "target-schema-test-widget";
	static schema = {
		name: field.string({ required: true }),
		count: field.int({ default: 1 }),
		dep: field.target({ required: false }),
	};
	constructor(attrs) {
		super({ kind: Widget.kind, attrs });
	}
}
product(Widget, BUILD, WIDGET_TOOL, () => {});

describe("Target attrs schema", () => {
	test("fills declared defaults", () => {
		const widget = new Widget({ name: "a" });
		expect(widget.attrs).toEqual({ name: "a", count: 1 });
	});

	test("throws on a missing required field", () => {
		expect(() => new Widget({ count: 2 })).toThrow(/missing required/);
	});

	test("throws on an undeclared attrs key", () => {
		expect(() => new Widget({ name: "a", bogus: true })).toThrow(
			/not declared/,
		);
	});

	test("throws on a type mismatch", () => {
		expect(() => new Widget({ name: "a", count: "two" })).toThrow(
			/must be an integer/,
		);
	});

	test("keeps a target-typed field as the live handle, not a validated copy", () => {
		const inner = target({ kind: Widget.kind, attrs: { name: "inner" } });
		const outer = new Widget({ name: "outer", dep: inner });
		expect(outer.attrs.dep).toBe(inner);
	});

	test("targetSchemas() reflects the declared schema by kind", () => {
		expect(targetSchemas()[Widget.kind]).toEqual(Widget.schema);
	});
});

const BASE_GADGET_TOOL = toolName("target-schema-test-base-gadget");
const GADGET_TOOL = toolName("target-schema-test-gadget");

class BaseGadget extends Target {
	static kind = "target-schema-test-base-gadget";
	static schema = {
		name: field.string({ required: true }),
		mode: field.enum(["debug", "release"], { default: "debug" }),
	};
	constructor(attrs) {
		super({ kind: new.target.kind, attrs });
	}
}
product(BaseGadget, BUILD, BASE_GADGET_TOOL, () => {});

// Declares no schema of its own for `mode` — should inherit BaseGadget's
// unchanged — but overrides `name`'s constraints and adds `version`.
class Gadget extends BaseGadget {
	static kind = "target-schema-test-gadget";
	static schema = {
		name: field.string({ default: "unnamed" }),
		version: field.int({ required: true }),
	};
}
product(Gadget, BUILD, GADGET_TOOL, () => {});

describe("Target attrs schema composition", () => {
	test("a subclass without its own schema inherits its ancestor's", () => {
		const gadget = new BaseGadget({ name: "a" });
		expect(gadget.attrs).toEqual({ name: "a", mode: "debug" });
	});

	test("a subclass's schema merges over its ancestor's, own fields winning", () => {
		const gadget = new Gadget({ version: 2 });
		// `name` no longer required (Gadget's own field.string() replaced
		// BaseGadget's), `mode` still comes from BaseGadget unchanged, and
		// `version` is Gadget's own addition.
		expect(gadget.attrs).toEqual({
			name: "unnamed",
			mode: "debug",
			version: 2,
		});
	});

	test("targetSchemas() reports the composed shape for a subclass kind", () => {
		expect(targetSchemas()[Gadget.kind]).toEqual({
			name: field.string({ default: "unnamed" }),
			mode: field.enum(["debug", "release"], { default: "debug" }),
			version: field.int({ required: true }),
		});
	});
});
