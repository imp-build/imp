-- Shared rendering for goal reports. The host prints a report as plain
-- output after the live progress UI stops. Units are sorted by status
-- severity, then by key. The key is aligned into a column and the status is
-- colored. Color is unconditional, as in `report.js`.
local RESET = "\27[0m"
local COLOR = { red = "\27[31m", yellow = "\27[33m", green = "\27[32m" }

local function index_of(list, value)
	for index, item in ipairs(list) do
		if item == value then
			return index
		end
	end
	return #list + 1
end

--- Render `{ key, status, output? }` units as a report: one aligned, colored
--- line per unit, then the output block of each unit that has one, then the
--- line that `options.summary(counts)` returns.
--- `options.order` lists the status values, most severe first.
--- `options.colors` maps a status value to "red", "yellow", or "green".
local function status_report(units, options)
	local sorted = table.clone(units)
	table.sort(sorted, function(a, b)
		local left = index_of(options.order, a.status)
		local right = index_of(options.order, b.status)
		if left ~= right then
			return left < right
		end
		return a.key < b.key
	end)
	local width = 0
	for _, unit in ipairs(sorted) do
		width = math.max(width, #unit.key)
	end
	width += 2
	local lines = {}
	for _, unit in ipairs(sorted) do
		local color = COLOR[options.colors[unit.status]] or ""
		local padding = string.rep(" ", width - #unit.key)
		table.insert(lines, unit.key .. padding .. color .. string.upper(unit.status) .. RESET)
	end
	for _, unit in ipairs(sorted) do
		if unit.output ~= nil and unit.output ~= "" then
			table.insert(lines, unit.key .. ":\n" .. unit.output)
		end
	end
	local counts = {}
	for _, status in ipairs(options.order) do
		counts[status] = 0
	end
	for _, unit in ipairs(units) do
		counts[unit.status] = (counts[unit.status] or 0) + 1
	end
	table.insert(lines, options.summary(counts))
	return table.concat(lines, "\n")
end

return {
	status_report = status_report,
}
