-- CI uses fewer concurrent actions than contributor workspaces.
return { cache = { gc_max_age_days = 3 }, imp = { jobs = 3, js_workers = 1 } }
