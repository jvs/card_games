//go:build dev

package web

import (
	"io/fs"
	"os"
)

// In dev, reads from disk so Vite output is picked up without rebuilding the binary.
var FS fs.FS = os.DirFS("web/dist")
