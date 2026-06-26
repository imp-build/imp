;; Root-level targets for the target/rule/goal planning spike.

(cpp-sources "joltphysics"
  #:sources '("**/*.h" "**/*.cpp"))

(cmake-lib "cmake"
  #:entrypoint "CMakeLists.txt"
  #:dependencies '(:joltphysics))

(odin-package "jodin"
  #:sources '("*.odin")
  #:dependencies (list (auto ":cmake")))
