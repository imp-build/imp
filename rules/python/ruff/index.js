// Ruff owns both Python formatting and linting products. Keeping the
// registrations here makes `python/ruff` their automatic provenance.
import { product, FMT, LINT } from "imp:core";
import { FORMAT_CHECK } from "//rules/workflows/products";
import { PythonApp } from "//rules/python";
import { ruffFmt, ruffFormatCheck } from "//rules/python/fmt";
import { ruffCheck } from "//rules/python/lint";

export const pythonAppFmt = product(PythonApp, FMT, ruffFmt);
export const pythonAppFormatCheck = product(PythonApp, FORMAT_CHECK, ruffFormatCheck);
export const pythonAppLint = product(PythonApp, LINT, ruffCheck);
