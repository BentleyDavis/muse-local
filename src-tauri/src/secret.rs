//! Secret storage (Windows): the Firebase token lives in Windows Credential
//! Manager ("muse-local/firebase-token"), which is DPAPI-backed — encrypted
//! with a key derived from the user's Windows login. It never sits in
//! plaintext on disk and never enters the repo.
//!
//! Honest scope: this stops other users on the machine and offline disk
//! theft. It does not stop malware already running as the user (it could
//! call the same APIs) — no unattended-use secret store can. The token's
//! blast radius is small by design: it only unlocks the Firebase command
//! channel, not the Google account or anything else.

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Security::Credentials::*;

    const TARGET: &str = "muse-local/firebase-token";
    const ERROR_NOT_FOUND: u32 = 1168;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn store_token(token: &str) -> Result<(), String> {
        if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err("token must be letters and numbers only".to_string());
        }
        let target = wide(TARGET);
        let blob = token.as_bytes();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: target.as_ptr() as *mut u16,
            Comment: std::ptr::null_mut(),
            LastWritten: windows_sys::Win32::Foundation::FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: std::ptr::null_mut(),
        };
        let ok = unsafe { CredWriteW(&cred, 0) };
        if ok == 0 {
            return Err(format!("CredWrite failed (os error {})", unsafe {
                GetLastError()
            }));
        }
        Ok(())
    }

    pub fn load_token() -> Result<Option<String>, String> {
        let target = wide(TARGET);
        let mut pcred: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pcred) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err(format!("CredRead failed (os error {})", err));
        }
        let result = unsafe {
            let c = &*pcred;
            let bytes =
                std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
            String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
        };
        unsafe { CredFree(pcred as *const std::ffi::c_void) };
        result.map(Some)
    }

    pub fn delete_token() -> Result<(), String> {
        let target = wide(TARGET);
        let ok = unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let err = unsafe { GetLastError() };
            if err == ERROR_NOT_FOUND {
                return Ok(());
            }
            return Err(format!("CredDelete failed (os error {})", err));
        }
        Ok(())
    }
}

#[tauri::command]
pub fn store_firebase_token(token: String) -> Result<(), String> {
    #[cfg(windows)]
    return win::store_token(&token);
    #[cfg(not(windows))]
    {
        let _ = &token;
        Err("secret storage is only supported on Windows".to_string())
    }
}

#[tauri::command]
pub fn delete_firebase_token() -> Result<(), String> {
    #[cfg(windows)]
    return win::delete_token();
    #[cfg(not(windows))]
    Err("secret storage is only supported on Windows".to_string())
}

/// Used by config::get_config to merge the stored token into the response.
/// Not exposed to the frontend directly.
#[cfg(windows)]
pub fn load_token() -> Result<Option<String>, String> {
    win::load_token()
}

#[cfg(not(windows))]
pub fn load_token() -> Result<Option<String>, String> {
    Ok(None)
}
