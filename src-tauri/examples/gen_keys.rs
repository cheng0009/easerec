use app_lib::license::LicenseManager;

fn main() {
    println!("=== DirectorCam Pro License Keys ===\n");
    for i in 1..=10 {
        let key = LicenseManager::generate_pro_key();
        println!("{:>2}. {}", i, key);
    }
    println!("\nEach key can activate one device.");
    println!("Format: XXXX-XXXX-XXXX-XXXX");
}