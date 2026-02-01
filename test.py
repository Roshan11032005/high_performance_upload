import requests
import sys

# Configuration
BASE_URL = "http://localhost:8085"
EMAIL_ID = "roshan@gmail.com"  # Use the email you used in the app

def test_file_sizes():
    print(f"\n--- 1. Checking File List & Sizes for {EMAIL_ID} ---")
    try:
        resp = requests.get(f"{BASE_URL}/files?email_id={EMAIL_ID}")
        if resp.status_code != 200:
            print(f"❌ Failed to list files: {resp.text}")
            return None

        files = resp.json().get('files', [])

        if not files:
            print("⚠️ No files found for this user.")
            return None

        print(f"📂 Found {len(files)} files:")
        valid_file = None

        for f in files:
            size_bytes = f.get('size', 0)
            size_mb = size_bytes / (1024 * 1024)
            print(f"   - {f['key']}")
            print(f"     Size: {size_bytes} bytes ({size_mb:.2f} MB)")

            if size_bytes == 0:
                print("     ❌ WARNING: Size is ZERO! S3 upload might have failed or metadata is missing.")
            else:
                valid_file = f

        return valid_file

    except Exception as e:
        print(f"❌ Connection error: {e}")
        return None

def test_preview_headers(file_info):
    if not file_info:
        return

    s3_key = file_info['key']
    print(f"\n--- 2. Testing Preview Headers for: {s3_key} ---")

    # Get Token
    try:
        resp = requests.post(f"{BASE_URL}/files/streaming-token", json={
            "email_id": EMAIL_ID,
            "s3_key": s3_key
        })
        if resp.status_code != 200:
            print(f"❌ Failed to get token: {resp.text}")
            return

        token = resp.json()['token']
        stream_url = f"{BASE_URL}/stream?token={token}"
        print(f"🔑 Token generated. URL: {stream_url}")

        # Head Request to check headers without downloading
        head_resp = requests.head(stream_url)

        print("\n🔹 Response Headers:")
        content_type = head_resp.headers.get('Content-Type', 'MISSING')
        disposition = head_resp.headers.get('Content-Disposition', 'MISSING')
        length = head_resp.headers.get('Content-Length', 'MISSING')

        print(f"   Content-Type: {content_type}")
        print(f"   Content-Disposition: {disposition}")
        print(f"   Content-Length: {length}")

        # Analysis
        if content_type == 'application/octet-stream' or content_type == 'MISSING':
             print("❌ ERROR: Content-Type is generic or missing. Browser won't preview this.")
             ext = s3_key.split('.')[-1]
             print(f"   Expected: video/mp4, application/pdf, etc. for extension .{ext}")
        else:
             print("✅ Content-Type looks specific.")

        if 'inline' in disposition:
             print("✅ Content-Disposition is 'inline' (Correct for preview).")
        else:
             print(f"❌ ERROR: Content-Disposition is '{disposition}'. Should be 'inline'.")

    except Exception as e:
        print(f"❌ Error testing preview: {e}")

def test_streaming_range(file_info):
    if not file_info: return

    print(f"\n--- 3. Testing Video Seek (Range Request) ---")
    s3_key = file_info['key']

    # Get Token
    resp = requests.post(f"{BASE_URL}/files/streaming-token", json={"email_id": EMAIL_ID, "s3_key": s3_key})
    token = resp.json()['token']

    # Request first 100 bytes
    headers = {"Range": "bytes=0-100"}
    stream_resp = requests.get(f"{BASE_URL}/stream?token={token}", headers=headers)

    if stream_resp.status_code == 206:
        print("✅ Backend returned HTTP 206 (Partial Content).")
        print(f"   Received {len(stream_resp.content)} bytes.")
    else:
        print(f"❌ Backend returned HTTP {stream_resp.status_code}. Video seeking/streaming will fail.")

if __name__ == "__main__":
    file_to_test = test_file_sizes()
    if file_to_test:
        test_preview_headers(file_to_test)
        test_streaming_range(file_to_test)
    else:
        print("\n❌ Could not proceed with preview tests because no valid file was found.")
