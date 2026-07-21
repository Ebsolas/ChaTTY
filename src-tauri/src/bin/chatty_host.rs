//! Durable session host process for Chatty.
//!
//! Owns PTYs so shells survive UI quit; UI reconnects over a local socket.
//!
//! Usage:
//!   chatty-host serve     # foreground server (daemon-friendly)
//!   chatty-host ping      # health check

fn main() {
    let mut args = std::env::args().skip(1);
    let cmd = args.next().unwrap_or_else(|| "serve".into());
    match cmd.as_str() {
        "serve" | "daemon" => {
            if let Err(e) = chatty_lib::host_server::run_server() {
                eprintln!("chatty-host error: {e}");
                std::process::exit(1);
            }
        }
        "ping" => {
            match chatty_lib::host_client::HostClient::connect_existing() {
                Ok(mut c) => match c.ping() {
                    Ok(v) => {
                        println!("{v}");
                        std::process::exit(0);
                    }
                    Err(e) => {
                        eprintln!("ping failed: {e}");
                        std::process::exit(2);
                    }
                },
                Err(e) => {
                    eprintln!("not running: {e}");
                    std::process::exit(2);
                }
            }
        }
        "help" | "-h" | "--help" => {
            eprintln!("chatty-host — durable PTY session host for Chatty\n");
            eprintln!("Commands:");
            eprintln!("  serve   Run the host (default)");
            eprintln!("  ping    Check if a host is listening");
        }
        other => {
            eprintln!("unknown command: {other}");
            std::process::exit(1);
        }
    }
}
