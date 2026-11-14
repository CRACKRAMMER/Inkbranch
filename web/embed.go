package webassets

import "embed"

// DistFS holds the Vite-built frontend assets and index.html template.
// Kept empty-safe via dist/.gitkeep so go test runs cleanly before web builds.
//
//go:embed all:dist
var DistFS embed.FS
