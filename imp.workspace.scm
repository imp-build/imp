;; Workspace extension configuration.
;;
;; These declarations are evaluated before any BUILD.scm file. Extensions can
;; introduce target kinds, products, rules, and their own convenient constructors
;; without recompiling the Rust engine.

(declare-target-type! "cpp-sources" #f)
(declare-target-type! "cmake-lib" "native-link-library")
(declare-target-type! "odin-package" "odin-package")

(declare-rule! "cpp-sources" "sources" "snapshot {sources}" #f #f)
(declare-rule! "cmake-lib" "native-link-library" "cmake --build {entrypoint}" #f "sources")
(declare-rule! "odin-package" "sources" "snapshot {sources}" #f #f)
(declare-rule! "odin-package" "odin-package" "odin build" #true "default")

(define (cpp-sources name #:sources sources)
  (declare-target! "cpp-sources" name sources #f '()))

(define (cmake-lib name #:entrypoint entrypoint #:dependencies [dependencies '()])
  (declare-target! "cmake-lib" name '() entrypoint dependencies))

(define (odin-package name #:sources sources #:dependencies [dependencies '()])
  (declare-target! "odin-package" name sources #f dependencies))
