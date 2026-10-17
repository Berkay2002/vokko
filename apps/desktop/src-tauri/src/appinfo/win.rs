//! Windows: the version strings and the 64x64 icon of an executable. Only this file calls into Win32.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;

use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDIBits, GetObjectW, HBITMAP, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO, PrivateExtractIconsW};
use windows::core::{PCWSTR, w};

/// The icon as the OS holds it: 32-bit BGRA, top-down, plus the 32-bit transparency mask (see `bgra_to_rgba`).
pub struct RawIcon {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
    pub mask: Option<Vec<u8>>,
}

#[derive(Default)]
pub struct Meta {
    pub description: Option<String>,
    pub product: Option<String>,
    pub icon: Option<RawIcon>,
}

pub fn read(path: &Path) -> Meta {
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let (description, product) = version_strings(&wide);
    Meta { description, product, icon: icon(&wide) }
}

/// `FileDescription` and `ProductName` from the exe's version resource, in its first listed language (else US English).
fn version_strings(wide_path: &[u16]) -> (Option<String>, Option<String>) {
    // SAFETY: `wide_path` is NUL-terminated; every buffer passed is sized by the call that fills it, and the string pointers
    // VerQueryValueW hands back point into `data`, which outlives their use here.
    unsafe {
        let path = PCWSTR(wide_path.as_ptr());
        let size = GetFileVersionInfoSizeW(path, None);
        if size == 0 {
            return (None, None);
        }
        let mut data = vec![0u8; size as usize];
        if GetFileVersionInfoW(path, Some(0), size, data.as_mut_ptr().cast()).is_err() {
            return (None, None);
        }
        let mut languages = vec!["040904b0".to_owned(), "040904e4".to_owned(), "000004b0".to_owned()];
        let mut pairs: *mut c_void = std::ptr::null_mut();
        let mut pairs_len = 0u32;
        if VerQueryValueW(data.as_ptr().cast(), w!("\\VarFileInfo\\Translation"), &mut pairs, &mut pairs_len).as_bool() && !pairs.is_null() {
            // an array of (language, code page) u16 pairs
            if pairs_len >= 4 {
                let first = std::ptr::read_unaligned(pairs.cast::<[u16; 2]>());
                languages.insert(0, format!("{:04x}{:04x}", first[0], first[1]));
            }
        }
        let query = |name: &str| -> Option<String> {
            languages.iter().find_map(|language| {
                let sub: Vec<u16> = format!("\\StringFileInfo\\{language}\\{name}").encode_utf16().chain(Some(0)).collect();
                let mut value: *mut c_void = std::ptr::null_mut();
                let mut len = 0u32;
                if !VerQueryValueW(data.as_ptr().cast(), PCWSTR(sub.as_ptr()), &mut value, &mut len).as_bool() || value.is_null() || len == 0 {
                    return None;
                }
                let text = std::slice::from_raw_parts(value.cast::<u16>(), len as usize);
                let end = text.iter().position(|unit| *unit == 0).unwrap_or(text.len());
                let text = String::from_utf16_lossy(&text[..end]);
                (!text.trim().is_empty()).then_some(text)
            })
        };
        (query("FileDescription"), query("ProductName"))
    }
}

/// The exe's first icon at 64x64. `PrivateExtractIconsW` takes a fixed 260-unit path, so longer paths get no icon.
fn icon(wide_path: &[u16]) -> Option<RawIcon> {
    let mut fixed = [0u16; 260];
    if wide_path.len() > fixed.len() {
        return None;
    }
    fixed[..wide_path.len()].copy_from_slice(wide_path);
    // SAFETY: the HICON and both bitmaps are owned by this function and released on every path out; `GetDIBits` writes at most
    // `width * height * 4` bytes into buffers of exactly that size.
    unsafe {
        let mut handles = [HICON::default()];
        let found = PrivateExtractIconsW(&fixed, 0, 64, 64, Some(&mut handles), None, 0);
        if found == 0 || found == u32::MAX || handles[0].is_invalid() {
            return None;
        }
        let mut info = ICONINFO::default();
        let raw = if GetIconInfo(handles[0], &mut info).is_ok() { bitmaps(info.hbmColor, info.hbmMask) } else { None };
        for bitmap in [info.hbmColor, info.hbmMask] {
            if !bitmap.is_invalid() {
                let _ = DeleteObject(HGDIOBJ(bitmap.0));
            }
        }
        let _ = DestroyIcon(handles[0]);
        raw
    }
}

unsafe fn bitmaps(color: HBITMAP, mask: HBITMAP) -> Option<RawIcon> {
    if color.is_invalid() {
        return None;
    }
    // SAFETY: the caller owns both bitmaps for the length of the call.
    unsafe {
        let mut bitmap = BITMAP::default();
        if GetObjectW(HGDIOBJ(color.0), size_of::<BITMAP>() as i32, Some(std::ptr::from_mut(&mut bitmap).cast())) == 0 {
            return None;
        }
        let (width, height) = (u32::try_from(bitmap.bmWidth).ok()?, u32::try_from(bitmap.bmHeight).ok()?);
        if width == 0 || height == 0 || width > 256 || height > 256 {
            return None;
        }
        let dc = CreateCompatibleDC(None);
        let pixels = |source: HBITMAP| -> Option<Vec<u8>> {
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: width as i32,
                    biHeight: -(height as i32), // negative: top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut buffer = vec![0u8; (width * height * 4) as usize];
            let rows = GetDIBits(dc, source, 0, height, Some(buffer.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
            (rows == height as i32).then_some(buffer)
        };
        let bgra = pixels(color);
        let mask = if mask.is_invalid() { None } else { pixels(mask) };
        let _ = DeleteDC(dc);
        Some(RawIcon { width, height, bgra: bgra?, mask })
    }
}
