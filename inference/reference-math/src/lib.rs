//! Portable scalar f32 primitives only. No model, matmul, attention or state logic.
//! The NumPy oracle independently implements inference using these same pinned
//! transcendental rounding rules, which are also checked between native and SBF.
#[no_mangle]
pub extern "C" fn expf(x: f32) -> f32 {
    libm::expf(x)
}
#[no_mangle]
pub extern "C" fn sinf(x: f32) -> f32 {
    libm::sincosf(x).0
}
#[no_mangle]
pub extern "C" fn cosf(x: f32) -> f32 {
    libm::sincosf(x).1
}
#[no_mangle]
pub extern "C" fn powf(x: f32, y: f32) -> f32 {
    libm::powf(x, y)
}
