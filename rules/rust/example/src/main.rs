fn greeting() -> &'static str {
    "Hello from imp Rust rules"
}

fn main() {
    println!("{}", greeting());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greeting_is_correct() {
        assert_eq!(greeting(), "Hello from imp Rust rules");
    }
}
