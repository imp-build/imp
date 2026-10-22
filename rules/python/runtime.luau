-- Default CPython version for Python graph declarations.
local version = "3.13.0"
--- Set the default CPython version. Existing declarations keep their version.
local function python_runtime(value)
	assert(type(value) == "string" and value ~= "", "python_runtime(version) requires a non-empty version string")
	version = value
end
return { python_runtime = python_runtime, default_python_runtime_version = function() return version end }
