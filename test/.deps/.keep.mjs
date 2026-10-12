// Local test-only stubs for the DSH peer packages this plugin is loaded with.
// They let test/plugin.test.mjs import and drive the real lib/index.js without a
// DSH installation. Nothing here ships (package.json `files` excludes test/).
export {};
