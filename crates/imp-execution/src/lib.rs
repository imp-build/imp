//! Local action execution for imp: sandboxed process runs (`exec`),
//! persistent worker processes (`worker`), and toolchain asset acquisition
//! (`fetch`). Consumes the CAS/digest layer from `imp-store`; knows nothing
//! about the JS rule graph.
pub mod exec;
pub mod service;
pub mod fetch;
pub mod worker;
