;; Root-level targets for the imp planning spike.
;;
;; Target types, rules, and schemas are defined in imp.workspace.scm.
;; Each constructor here passes keyword arguments that are validated against
;; the field schema declared for that target type:
;;
;;   cpp-sources  — required: #:sources
;;   cmake-lib    — required: #:entrypoint  optional: #:dependencies
;;   odin-package — required: #:sources     optional: #:dependencies

;; A grab of every C++ header and translation unit under this directory.
;; The schema enforces that 'sources' is always supplied (required field).
(cpp-sources "joltphysics"
  #:sources '("**/*.h" "**/*.cpp"))

;; A CMake library wrapping the joltphysics sources above.
;; 'entrypoint' (required) points to the root CMakeLists.txt.
;; 'dependencies' is optional; defaults to an empty list if omitted.
(cmake-lib "cmake"
  #:entrypoint   "CMakeLists.txt"
  #:dependencies '(:joltphysics))

;; An Odin package that links against the CMake library at runtime.
;; 'dependencies' is optional here but listed explicitly so the planner
;; can resolve the native-link-library product from the cmake target.
(odin-package "jodin"
  #:sources      '("*.odin")
  #:dependencies (list (auto ":cmake")))
