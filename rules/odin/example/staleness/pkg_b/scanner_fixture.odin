package pkg_b

// import "../missing/from-line-comment"
/* import "../missing/from-block-comment" */

quoted := "import \"../missing/from-string\""
raw := `
import "../missing/from-raw-string"
`

import "../pkg_a"

ScannerValue :: pkg_a.Value
