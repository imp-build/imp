;; Workspace extension configuration.
;;
;; These declarations are evaluated before any BUILD.scm file. Extensions can
;; introduce target kinds, products, rules, and their own convenient constructors
;; without recompiling the Rust engine.

;; ---------------------------------------------------------------------------
;; Target-type declarations
;; ---------------------------------------------------------------------------

(declare-target-type! "cpp-sources"  #f)
(declare-target-type! "cmake-lib"    "native-link-library")
(declare-target-type! "odin-package" "odin-package")

;; ---------------------------------------------------------------------------
;; Rules
;; ---------------------------------------------------------------------------

(declare-rule! "cpp-sources"  "sources"             "snapshot {sources}"         #f    #f)
(declare-rule! "cmake-lib"    "native-link-library" "cmake --build {entrypoint}" #f    "sources")
(declare-rule! "odin-package" "sources"             "snapshot {sources}"         #f    #f)
(declare-rule! "odin-package" "odin-package"        "odin build"                 #true "default")

;; ---------------------------------------------------------------------------
;; Schemas
;;
;; Each field descriptor is a list of 3–5 elements:
;;   (name type required? [default [validator-expr]])
;; Types: string | list | boolean | any
;;
;; Note: `list` fields are stored as comma-joined strings in the field map.
;; The type annotation is documentation-level; the host checks boolean
;; values (#t/#f) and required presence, but does not inspect list structure.
;; ---------------------------------------------------------------------------

;; cpp-sources: a set of glob patterns covering headers and translation units.
(declare-target-schema! "cpp-sources"
  (list
    (list "sources" "list" "#t")))     ; required

;; cmake-lib: a CMake project that produces a native link library.
;; entrypoint points to the CMakeLists.txt file.
(declare-target-schema! "cmake-lib"
  (list
    (list "entrypoint" "string" "#t"))) ; required

;; odin-package: an Odin compilation unit.
(declare-target-schema! "odin-package"
  (list
    (list "sources" "list" "#t")))     ; required

;; ---------------------------------------------------------------------------
;; Constructors (schema-validated API)
;;
;; Constructors call declare-target-with-fields! which:
;;   1. Checks all required fields are present.
;;   2. Fills in defaults for missing optional fields.
;;   3. Rejects any fields not declared in the schema.
;;
;; The dependency list is passed as the 4th argument directly (not as a
;; field) so that the planner can resolve addresses across build files.
;; ---------------------------------------------------------------------------

(define (cpp-sources name #:sources sources)
  (declare-target-with-fields!
    "cpp-sources"
    name
    (list
      (list "sources" (string-join sources ",")))
    (list)))

(define (cmake-lib name
                   #:entrypoint   entrypoint
                   #:dependencies [dependencies '()])
  (declare-target-with-fields!
    "cmake-lib"
    name
    (list
      (list "entrypoint" entrypoint))
    dependencies))

(define (odin-package name
                      #:sources      sources
                      #:dependencies [dependencies '()])
  (declare-target-with-fields!
    "odin-package"
    name
    (list
      (list "sources" (string-join sources ",")))
    dependencies))
