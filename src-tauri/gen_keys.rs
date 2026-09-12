fn main() {
    for i in 1..=10 {
        let key = app_lib::license::LicenseManager::generate_pro_key();
        println!("{:>2}. {}", i, key);
    }
}