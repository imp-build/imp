import {
    describe,
    expect,
    test,
} from "//rules/imp/test";
import {
    odinPackageFmt,
    odinTestPackageFmt,
    odinPackageFormatCheck,
    odinTestPackageFormatCheck,
} from "//rules/workflows/fmt";

describe("fmt workflow", () => {

test("fmt/format-check products are declared for odin-package and odin-test-package", () => {
    expect(typeof odinPackageFmt).toBe("function");
    expect(typeof odinTestPackageFmt).toBe("function");
    expect(typeof odinPackageFormatCheck).toBe("function");
    expect(typeof odinTestPackageFormatCheck).toBe("function");
});

});
