// Ruff owns both Python formatting and linting products. Keeping the
// registrations here makes `python/ruff` their automatic provenance.
import { product } from "imp:core";
import { ruffFmt, ruffFormatCheck } from "//rules/python/fmt";
import { ruffCheck } from "//rules/python/lint";

export const pythonAppFmt = product("python-app", "fmt", ruffFmt);
export const pythonAppFormatCheck = product("python-app", "format-check", ruffFormatCheck);
export const pythonAppLint = product("python-app", "lint", ruffCheck);
