//go:build !dev

package web

import (
	"embed"
	"io/fs"
	"log"
)

//go:embed all:dist
var files embed.FS

var FS fs.FS

func init() {
	var err error
	FS, err = fs.Sub(files, "dist")
	if err != nil {
		log.Fatal(err)
	}
}
