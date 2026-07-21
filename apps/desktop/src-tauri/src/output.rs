use std::{io::Cursor, path::Path};

fn decode_png_rgba(png_bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(Cursor::new(png_bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|error| format!("invalid PNG: {error}"))?;
    let mut decoded = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut decoded)
        .map_err(|error| format!("invalid PNG pixels: {error}"))?;
    let source = &decoded[..info.buffer_size()];
    let pixel_count = usize::try_from(info.width)
        .ok()
        .zip(usize::try_from(info.height).ok())
        .and_then(|(width, height)| width.checked_mul(height))
        .ok_or_else(|| "PNG dimensions are too large".to_string())?;
    let mut rgba = Vec::with_capacity(
        pixel_count
            .checked_mul(4)
            .ok_or_else(|| "PNG dimensions are too large".to_string())?,
    );

    match info.color_type {
        png::ColorType::Rgba => rgba.extend_from_slice(source),
        png::ColorType::Rgb => {
            for pixel in source.chunks_exact(3) {
                rgba.extend_from_slice(&[pixel[0], pixel[1], pixel[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            for value in source {
                rgba.extend_from_slice(&[*value, *value, *value, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for pixel in source.chunks_exact(2) {
                rgba.extend_from_slice(&[pixel[0], pixel[0], pixel[0], pixel[1]]);
            }
        }
        png::ColorType::Indexed => {
            return Err("indexed PNG was not expanded by the decoder".to_string());
        }
    }

    if rgba.len() != pixel_count * 4 {
        return Err("decoded PNG has an invalid pixel buffer".to_string());
    }
    Ok((info.width, info.height, rgba))
}

fn png_to_dib(png_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let (width, height, rgba) = decode_png_rgba(png_bytes)?;
    let width_i32 = i32::try_from(width).map_err(|_| "PNG width is too large".to_string())?;
    let height_i32 = i32::try_from(height).map_err(|_| "PNG height is too large".to_string())?;
    let image_size = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "PNG dimensions are too large".to_string())?;
    let mut dib = Vec::with_capacity(40 + image_size as usize);

    dib.extend_from_slice(&40_u32.to_le_bytes());
    dib.extend_from_slice(&width_i32.to_le_bytes());
    dib.extend_from_slice(&height_i32.to_le_bytes());
    dib.extend_from_slice(&1_u16.to_le_bytes());
    dib.extend_from_slice(&32_u16.to_le_bytes());
    dib.extend_from_slice(&0_u32.to_le_bytes());
    dib.extend_from_slice(&image_size.to_le_bytes());
    dib.extend_from_slice(&0_i32.to_le_bytes());
    dib.extend_from_slice(&0_i32.to_le_bytes());
    dib.extend_from_slice(&0_u32.to_le_bytes());
    dib.extend_from_slice(&0_u32.to_le_bytes());

    let row_bytes = width as usize * 4;
    for row in (0..height as usize).rev() {
        for pixel in rgba[row * row_bytes..(row + 1) * row_bytes].chunks_exact(4) {
            dib.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }
    Ok(dib)
}

#[cfg(windows)]
fn write_windows_clipboard(png_bytes: &[u8], dib: &[u8]) -> Result<(), String> {
    let _clipboard = clipboard_win::Clipboard::new_attempts(10)
        .map_err(|error| format!("failed to open clipboard: {error}"))?;
    clipboard_win::empty().map_err(|error| format!("failed to empty clipboard: {error}"))?;
    clipboard_win::raw::set_without_clear(clipboard_win::formats::CF_DIB, dib)
        .map_err(|error| format!("failed to publish CF_DIB clipboard data: {error}"))?;
    let png_format = clipboard_win::register_format("PNG")
        .ok_or_else(|| "failed to register PNG clipboard format".to_string())?;
    clipboard_win::raw::set_without_clear(png_format.get(), png_bytes)
        .map_err(|error| format!("failed to publish PNG clipboard data: {error}"))
}

#[tauri::command]
pub fn copy_png(png_bytes: Vec<u8>) -> Result<(), String> {
    let dib = png_to_dib(&png_bytes)?;
    #[cfg(windows)]
    {
        write_windows_clipboard(&png_bytes, &dib)
    }
    #[cfg(not(windows))]
    {
        let _ = dib;
        Err("native image clipboard output is currently supported only on Windows".to_string())
    }
}

#[tauri::command]
pub async fn save_png(
    _window: tauri::Window,
    png_bytes: Vec<u8>,
    suggested_name: String,
) -> Result<Option<String>, String> {
    decode_png_rgba(&png_bytes)?;
    let filename = Path::new(&suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("screenshot.png");
    let path = rfd::AsyncFileDialog::new()
        .add_filter("PNG image", &["png"])
        .set_file_name(filename)
        .save_file()
        .await;
    let Some(path) = path else {
        return Ok(None);
    };
    std::fs::write(path.path(), png_bytes)
        .map_err(|error| format!("failed to save PNG: {error}"))?;
    Ok(Some(path.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn close_overlay(window: tauri::Window) -> Result<(), String> {
    window
        .hide()
        .map_err(|error| format!("failed to hide screenshot overlay: {error}"))
}

#[cfg(test)]
mod tests {
    use super::png_to_dib;

    fn two_row_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, 1, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("header should encode");
        writer
            .write_image_data(&[255, 0, 0, 255, 0, 0, 255, 128])
            .expect("pixels should encode");
        drop(writer);
        bytes
    }

    #[test]
    fn dib_has_bitmap_info_header_and_bottom_up_bgra_pixels() {
        let dib = png_to_dib(&two_row_png()).expect("PNG should convert");

        assert_eq!(u32::from_le_bytes(dib[0..4].try_into().unwrap()), 40);
        assert_eq!(i32::from_le_bytes(dib[4..8].try_into().unwrap()), 1);
        assert_eq!(i32::from_le_bytes(dib[8..12].try_into().unwrap()), 2);
        assert_eq!(&dib[40..44], &[255, 0, 0, 128]);
        assert_eq!(&dib[44..48], &[0, 0, 255, 255]);
    }

    #[test]
    fn invalid_png_is_rejected() {
        assert!(png_to_dib(b"not a png").is_err());
    }
}
