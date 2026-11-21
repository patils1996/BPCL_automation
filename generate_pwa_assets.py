from PIL import Image, ImageOps, ImageDraw
import json
import os

# 1. Load official BPCL emblem
src_path = 'bpcl_emblem_official.png'
if not os.path.exists(src_path):
    src_path = 'bpcl_logo_card.png'

emblem = Image.open(src_path).convert('RGBA')

# Function to create standard icon with white background
def create_icon(size, padding_ratio=0.85):
    img = Image.new('RGBA', (size, size), (255, 255, 255, 255))
    target_size = int(size * padding_ratio)
    resized = emblem.resize((target_size, target_size), Image.Resampling.LANCZOS)
    offset = ((size - target_size) // 2, (size - target_size) // 2)
    img.paste(resized, offset, resized)
    return img

# Function to create maskable icon with safe zone padding (80% safe area)
def create_maskable_icon(size):
    return create_icon(size, padding_ratio=0.72)

# Generate icons
create_icon(192).save('icon-192.png', 'PNG')
create_icon(512).save('icon-512.png', 'PNG')
create_maskable_icon(192).save('icon-maskable-192.png', 'PNG')
create_maskable_icon(512).save('icon-maskable-512.png', 'PNG')
create_icon(180).save('apple-touch-icon.png', 'PNG')

print("Generated PWA icons successfully:")
for name in ['icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'apple-touch-icon.png']:
    print(f" - {name} ({os.path.getsize(name)} bytes)")

# 2. Create manifest.json
manifest_data = {
    "name": "BPCL Automation Uptime Dashboard",
    "short_name": "BPCL Uptime",
    "description": "Bharat Petroleum Belgaum Territory Automation & Uptime Monitoring",
    "start_url": "./index.html",
    "scope": "./",
    "display": "standalone",
    "background_color": "#01204c",
    "theme_color": "#01204c",
    "orientation": "any",
    "categories": ["business", "productivity", "utilities"],
    "icons": [
        {
            "src": "icon-192.png",
            "sizes": "192x192",
            "type": "image/png",
            "purpose": "any"
        },
        {
            "src": "icon-512.png",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "any"
        },
        {
            "src": "icon-maskable-192.png",
            "sizes": "192x192",
            "type": "image/png",
            "purpose": "maskable"
        },
        {
            "src": "icon-maskable-512.png",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "maskable"
        }
    ]
}

with open('manifest.json', 'w', encoding='utf-8') as f:
    json.dump(manifest_data, f, indent=2)

print("Generated manifest.json successfully!")
