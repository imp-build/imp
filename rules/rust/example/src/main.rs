include!("generated.rs");

fn greeting() -> &'static str {
    "Hello from imp Rust rules"
}

fn main() {
    println!("{} {}", greeting(), GENERATED_VALUE);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greeting_is_correct() {
        assert_eq!(greeting(), "Hello from imp Rust rules");
    }

    #[test]
    fn generated_source_is_available() {
        assert_eq!(GENERATED_VALUE, "generated");
    }
}
