+++
title = "imp"
description = "A hermetic, content-addressed build system."
template = "index.html"
+++

imp builds your project the same way every time, on every machine — no ambient PATH, no "works on my machine". Toolchains are downloaded, pinned, and sandboxed; every build step is cached by the content it actually depends on.

Build graphs are declared in plain JavaScript (`BUILD.js`), evaluated inside an embedded runtime — no separate config language to learn.
