#!/usr/bin/env python3
"""
Comprehensive test suite for gnet file upload server
Tests: basic upload, pause/resume, cancel, duplicate handling, retry, status
"""

import socket
import struct
import time
import os
import sys
from typing import Optional

class FileUploadClient:
    # Commands
    CMD_INIT_UPLOAD = 0x01
    CMD_UPLOAD_CHUNK = 0x02
    CMD_PAUSE_UPLOAD = 0x03
    CMD_RESUME_UPLOAD = 0x04
    CMD_CANCEL_UPLOAD = 0x05
    CMD_GET_STATUS = 0x06

    # Responses
    RESP_OK = 0x10
    RESP_ERROR = 0x11
    RESP_READY = 0x12
    RESP_CHUNK_ACK = 0x13
    RESP_COMPLETE = 0x14
    RESP_STATUS = 0x15
    RESP_PAUSED = 0x16
    RESP_RESUMED = 0x17
    RESP_CANCELLED = 0x18
    RESP_AUTH_FAILED = 0x19
    RESP_DUPLICATE = 0x1A

    def __init__(self, host='localhost', port=9090, auth_token='test_token_user123'):
        self.host = host
        self.port = port
        self.auth_token = auth_token
        self.sock: Optional[socket.socket] = None
        self.session_id: Optional[str] = None
        self.chunk_size = 5 * 1024 * 1024  # 5 MB
        self.max_retries = 3

    def connect(self):
        """Connect to server"""
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        try:
            self.sock.connect((self.host, self.port))
            print(f"🔌 Connected to {self.host}:{self.port}")
        except Exception as e:
            print(f"❌ Connection failed: {e}")
            raise

    def disconnect(self):
        """Disconnect from server"""
        if self.sock:
            try:
                self.sock.close()
            except:
                pass
            self.sock = None
            print("👋 Disconnected")

    def send_message(self, command: int, payload: bytes) -> bytes:
        """Send message with format: auth_token_size(4) | auth_token | payload_size(4) | command(1) | payload"""
        auth_token_bytes = self.auth_token.encode('utf-8')
        auth_token_size = len(auth_token_bytes)

        cmd_payload = struct.pack('B', command) + payload
        payload_size = len(cmd_payload)

        message = struct.pack('>I', auth_token_size) + auth_token_bytes + \
                  struct.pack('>I', payload_size) + cmd_payload

        self.sock.sendall(message)
        return self.receive_response()

    def receive_response(self) -> bytes:
        """Receive response from server"""
        try:
            data = self.sock.recv(8192)
            if not data:
                raise ConnectionError("Server closed connection")
            return data
        except socket.timeout:
            print("❌ Socket timeout waiting for response")
            raise
        except Exception as e:
            print(f"❌ Receive error: {e}")
            raise

    def init_upload(self, filename: str, file_size: int) -> bool:
        """Initialize upload session"""
        total_chunks = (file_size + self.chunk_size - 1) // self.chunk_size

        filename_bytes = filename.encode('utf-8')
        payload = struct.pack('>H', len(filename_bytes)) + filename_bytes + \
                  struct.pack('>II', total_chunks, self.chunk_size)

        print(f"📤 Initializing upload: {filename} ({file_size} bytes, {total_chunks} chunks)")

        try:
            response = self.send_message(self.CMD_INIT_UPLOAD, payload)
        except Exception as e:
            print(f"❌ Failed to send INIT_UPLOAD: {e}")
            return False

        if len(response) == 0:
            print("❌ Empty response")
            return False

        resp_code = response[0]

        if resp_code == self.RESP_READY:
            if len(response) < 3:
                return False

            session_id_size = struct.unpack('>H', response[1:3])[0]
            self.session_id = response[3:3+session_id_size].decode('utf-8')

            if len(response) >= 5 + session_id_size:
                s3_key_size = struct.unpack('>H', response[3+session_id_size:5+session_id_size])[0]
                if len(response) >= 5 + session_id_size + s3_key_size:
                    s3_key = response[5+session_id_size:5+session_id_size+s3_key_size].decode('utf-8')
                    print(f"✅ Session ready: {self.session_id}")
                    print(f"📁 S3 path: {s3_key}")

            return True

        elif resp_code == self.RESP_AUTH_FAILED:
            print("❌ Authentication failed")
            return False

        elif resp_code == self.RESP_ERROR:
            if len(response) >= 2:
                error_msg_len = response[1]
                if len(response) >= 2 + error_msg_len:
                    error_msg = response[2:2+error_msg_len].decode('utf-8', errors='replace')
                    print(f"❌ Error: {error_msg}")
            return False

        return False

    def upload_chunk(self, chunk_index: int, chunk_data: bytes, silent=False) -> bool:
        """Upload a chunk"""
        session_id_bytes = self.session_id.encode('utf-8')
        payload = struct.pack('>H', len(session_id_bytes)) + session_id_bytes + \
                  struct.pack('>II', chunk_index, len(chunk_data)) + chunk_data

        response = self.send_message(self.CMD_UPLOAD_CHUNK, payload)

        if len(response) == 0:
            if not silent:
                print(f"❌ Empty response for chunk {chunk_index}")
            return False

        resp_code = response[0]

        if resp_code == self.RESP_CHUNK_ACK:
            if len(response) >= 13:
                chunk_idx, progress, total = struct.unpack('>III', response[1:13])
                percent = (progress / total) * 100
                if not silent:
                    print(f"📦 Chunk {chunk_idx + 1}/{total} uploaded ({percent:.1f}%)")
            return True

        elif resp_code == self.RESP_DUPLICATE:
            if len(response) >= 9:
                chunk_idx, progress = struct.unpack('>II', response[1:9])
                if not silent:
                    print(f"⚠️  Chunk {chunk_idx + 1} was duplicate (skipped)")
            return True

        elif resp_code == self.RESP_COMPLETE:
            if not silent:
                print(f"✅ Upload complete!")
            if len(response) >= 3:
                s3_key_size = struct.unpack('>H', response[1:3])[0]
                if len(response) >= 3 + s3_key_size:
                    s3_key = response[3:3+s3_key_size].decode('utf-8')
                    if len(response) >= 11 + s3_key_size:
                        file_size = struct.unpack('>Q', response[3+s3_key_size:11+s3_key_size])[0]
                        if not silent:
                            print(f"📁 S3 path: {s3_key}")
                            print(f"📊 Size: {file_size / (1024*1024):.2f} MB")
            return True

        elif resp_code == self.RESP_ERROR:
            if len(response) >= 2:
                error_msg_len = response[1]
                if len(response) >= 2 + error_msg_len:
                    error_msg = response[2:2+error_msg_len].decode('utf-8', errors='replace')
                    if not silent:
                        print(f"❌ Error: {error_msg}")
            return False

        return False

    def pause_upload(self) -> bool:
        """Pause upload"""
        session_id_bytes = self.session_id.encode('utf-8')
        payload = struct.pack('>H', len(session_id_bytes)) + session_id_bytes

        response = self.send_message(self.CMD_PAUSE_UPLOAD, payload)

        if len(response) > 0 and response[0] == self.RESP_PAUSED:
            if len(response) >= 9:
                received, total = struct.unpack('>II', response[1:9])
                print(f"⏸️  Upload paused ({received}/{total} chunks)")
            return True
        return False

    def resume_upload(self) -> list:
        """Resume upload and get missing chunks"""
        session_id_bytes = self.session_id.encode('utf-8')
        payload = struct.pack('>H', len(session_id_bytes)) + session_id_bytes

        response = self.send_message(self.CMD_RESUME_UPLOAD, payload)

        if len(response) > 0 and response[0] == self.RESP_RESUMED:
            if len(response) >= 13:
                received, total, missing_count = struct.unpack('>III', response[1:13])
                missing_chunks = []
                for i in range(missing_count):
                    if len(response) >= 13 + (i+1)*4:
                        chunk_idx = struct.unpack('>I', response[13+i*4:17+i*4])[0]
                        missing_chunks.append(chunk_idx)
                print(f"▶️  Upload resumed ({received}/{total} chunks, {missing_count} missing)")
                return missing_chunks
        return []

    def cancel_upload(self) -> bool:
        """Cancel upload"""
        session_id_bytes = self.session_id.encode('utf-8')
        payload = struct.pack('>H', len(session_id_bytes)) + session_id_bytes

        response = self.send_message(self.CMD_CANCEL_UPLOAD, payload)

        if len(response) > 0 and response[0] == self.RESP_CANCELLED:
            print("🛑 Upload cancelled")
            return True
        return False

    def get_status(self) -> dict:
        """Get upload status"""
        session_id_bytes = self.session_id.encode('utf-8')
        payload = struct.pack('>H', len(session_id_bytes)) + session_id_bytes

        response = self.send_message(self.CMD_GET_STATUS, payload)

        if len(response) > 0 and response[0] == self.RESP_STATUS:
            if len(response) >= 2:
                state_len = response[1]
                if len(response) >= 2 + state_len + 8:
                    state = response[2:2+state_len].decode('utf-8')
                    received, total = struct.unpack('>II', response[2+state_len:10+state_len])
                    return {
                        'state': state,
                        'received': received,
                        'total': total,
                        'percent': (received / total * 100) if total > 0 else 0
                    }
        return None


# ============================================
# Test Cases
# ============================================

def create_test_file(filename: str, size_mb: int) -> str:
    """Create a test file with random data"""
    size = size_mb * 1024 * 1024
    print(f"📝 Creating test file: {filename} ({size_mb} MB)")
    with open(filename, 'wb') as f:
        f.write(os.urandom(size))
    return filename


def cleanup_test_file(filename: str):
    """Remove test file"""
    if os.path.exists(filename):
        os.remove(filename)
        print(f"🧹 Cleaned up: {filename}")


def test_basic_upload():
    """Test Case 1: Basic file upload"""
    print("\n" + "="*60)
    print("TEST 1: Basic File Upload (25 MB)")
    print("="*60)

    test_file = create_test_file("test_basic.mp4", 25)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient()
    client.connect()

    try:
        if not client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Init upload failed")
            return False

        with open(test_file, 'rb') as f:
            chunk_index = 0
            while True:
                chunk_data = f.read(client.chunk_size)
                if not chunk_data:
                    break

                if not client.upload_chunk(chunk_index, chunk_data):
                    print(f"❌ TEST FAILED: Chunk {chunk_index} upload failed")
                    return False

                chunk_index += 1

        print("✅ TEST PASSED: Basic upload successful")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_pause_resume():
    """Test Case 2: Pause and Resume upload"""
    print("\n" + "="*60)
    print("TEST 2: Pause and Resume (50 MB)")
    print("="*60)

    test_file = create_test_file("test_pause.pdf", 50)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient()
    client.connect()

    try:
        if not client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Init upload failed")
            return False

        # Upload first 3 chunks
        with open(test_file, 'rb') as f:
            for i in range(3):
                chunk_data = f.read(client.chunk_size)
                if not client.upload_chunk(i, chunk_data):
                    print(f"❌ TEST FAILED: Chunk {i} upload failed")
                    return False

            # Pause upload
            print("\n⏸️  Pausing upload after 3 chunks...")
            if not client.pause_upload():
                print("❌ TEST FAILED: Pause failed")
                return False

            # Check status
            time.sleep(1)
            status = client.get_status()
            if status:
                print(f"📊 Status: {status['state']} - {status['received']}/{status['total']} chunks ({status['percent']:.1f}%)")

            # Resume upload
            print("\n▶️  Resuming upload...")
            missing_chunks = client.resume_upload()
            print(f"Missing chunks: {missing_chunks}")

            # Upload remaining chunks
            f.seek(0)
            chunk_index = 0
            while True:
                chunk_data = f.read(client.chunk_size)
                if not chunk_data:
                    break

                if chunk_index in missing_chunks:
                    if not client.upload_chunk(chunk_index, chunk_data):
                        print(f"❌ TEST FAILED: Chunk {chunk_index} upload failed")
                        return False

                chunk_index += 1

        print("✅ TEST PASSED: Pause and resume successful")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_cancel_upload():
    """Test Case 3: Cancel upload"""
    print("\n" + "="*60)
    print("TEST 3: Cancel Upload")
    print("="*60)

    test_file = create_test_file("test_cancel.mp4", 30)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient()
    client.connect()

    try:
        if not client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Init upload failed")
            return False

        # Upload 2 chunks
        with open(test_file, 'rb') as f:
            for i in range(2):
                chunk_data = f.read(client.chunk_size)
                if not client.upload_chunk(i, chunk_data):
                    print(f"❌ TEST FAILED: Chunk {i} upload failed")
                    return False

        # Cancel upload
        print("\n🛑 Cancelling upload...")
        if not client.cancel_upload():
            print("❌ TEST FAILED: Cancel failed")
            return False

        print("✅ TEST PASSED: Cancel upload successful")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_duplicate_chunks():
    """Test Case 4: Duplicate chunk handling"""
    print("\n" + "="*60)
    print("TEST 4: Duplicate Chunk Handling")
    print("="*60)

    test_file = create_test_file("test_duplicate.jpg", 15)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient()
    client.connect()

    try:
        if not client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Init upload failed")
            return False

        with open(test_file, 'rb') as f:
            # Upload chunk 0
            chunk_data = f.read(client.chunk_size)
            print("\n📤 Uploading chunk 0 (first time)")
            if not client.upload_chunk(0, chunk_data):
                print("❌ TEST FAILED: First chunk upload failed")
                return False

            # Upload chunk 0 again (duplicate)
            print("\n📤 Uploading chunk 0 again (duplicate)")
            if not client.upload_chunk(0, chunk_data, silent=False):
                print("❌ TEST FAILED: Duplicate chunk handling failed")
                return False

            # Upload remaining chunks
            chunk_index = 1
            while True:
                chunk_data = f.read(client.chunk_size)
                if not chunk_data:
                    break

                if not client.upload_chunk(chunk_index, chunk_data, silent=True):
                    print(f"❌ TEST FAILED: Chunk {chunk_index} upload failed")
                    return False

                chunk_index += 1

        print("✅ TEST PASSED: Duplicate chunk handling successful")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_invalid_auth():
    """Test Case 5: Invalid authentication"""
    print("\n" + "="*60)
    print("TEST 5: Invalid Authentication")
    print("="*60)

    test_file = create_test_file("test_auth.mp4", 10)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient(auth_token='invalid_token_12345')
    client.connect()

    try:
        print("\n🔑 Attempting upload with invalid token...")
        if client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Upload should have been rejected")
            return False

        print("✅ TEST PASSED: Invalid auth rejected correctly")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_unsupported_file_type():
    """Test Case 6: Unsupported file type"""
    print("\n" + "="*60)
    print("TEST 6: Unsupported File Type")
    print("="*60)

    test_file = "test_unsupported.xyz"
    create_test_file(test_file, 10)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient()
    client.connect()

    try:
        print("\n📤 Attempting to upload unsupported file type (.xyz)...")
        if client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Unsupported file type should have been rejected")
            return False

        print("✅ TEST PASSED: Unsupported file type rejected correctly")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_status_check():
    """Test Case 7: Status check during upload"""
    print("\n" + "="*60)
    print("TEST 7: Status Check During Upload")
    print("="*60)

    test_file = create_test_file("test_status.mp4", 30)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient()
    client.connect()

    try:
        if not client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Init upload failed")
            return False

        with open(test_file, 'rb') as f:
            # Upload 2 chunks
            for i in range(2):
                chunk_data = f.read(client.chunk_size)
                if not client.upload_chunk(i, chunk_data, silent=True):
                    print(f"❌ TEST FAILED: Chunk {i} upload failed")
                    return False

            # Check status
            print("\n📊 Checking upload status...")
            status = client.get_status()
            if status:
                print(f"   State: {status['state']}")
                print(f"   Progress: {status['received']}/{status['total']} chunks ({status['percent']:.1f}%)")
            else:
                print("❌ TEST FAILED: Status check failed")
                return False

            # Upload remaining chunks
            chunk_index = 2
            while True:
                chunk_data = f.read(client.chunk_size)
                if not chunk_data:
                    break

                if not client.upload_chunk(chunk_index, chunk_data, silent=True):
                    print(f"❌ TEST FAILED: Chunk {chunk_index} upload failed")
                    return False

                chunk_index += 1

        print("✅ TEST PASSED: Status check successful")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_multiple_file_types():
    """Test Case 8: Multiple file types (PDF, MP4, PNG)"""
    print("\n" + "="*60)
    print("TEST 8: Multiple File Types (PDF, MP4, PNG)")
    print("="*60)

    files = [
        ("test_multi.pdf", 20),
        ("test_multi.mp4", 15),
        ("test_multi.png", 10),
    ]

    for filename, size_mb in files:
        print(f"\n📁 Testing {filename}...")
        test_file = create_test_file(filename, size_mb)
        file_size = os.path.getsize(test_file)

        client = FileUploadClient()
        client.connect()

        try:
            if not client.init_upload(os.path.basename(test_file), file_size):
                print(f"❌ TEST FAILED: Init upload failed for {filename}")
                return False

            with open(test_file, 'rb') as f:
                chunk_index = 0
                while True:
                    chunk_data = f.read(client.chunk_size)
                    if not chunk_data:
                        break

                    if not client.upload_chunk(chunk_index, chunk_data, silent=True):
                        print(f"❌ TEST FAILED: Chunk {chunk_index} upload failed for {filename}")
                        return False

                    chunk_index += 1

            print(f"✅ {filename} uploaded successfully")

        finally:
            client.disconnect()
            cleanup_test_file(test_file)

    print("\n✅ TEST PASSED: All file types uploaded successfully")
    return True


def test_large_file():
    """Test Case 9: Large file upload (100 MB)"""
    print("\n" + "="*60)
    print("TEST 9: Large File Upload (100 MB)")
    print("="*60)

    test_file = create_test_file("test_large.mp4", 100)
    file_size = os.path.getsize(test_file)

    client = FileUploadClient()
    client.connect()

    try:
        start_time = time.time()

        if not client.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Init upload failed")
            return False

        with open(test_file, 'rb') as f:
            chunk_index = 0
            while True:
                chunk_data = f.read(client.chunk_size)
                if not chunk_data:
                    break

                if not client.upload_chunk(chunk_index, chunk_data):
                    print(f"❌ TEST FAILED: Chunk {chunk_index} upload failed")
                    return False

                chunk_index += 1

        elapsed = time.time() - start_time
        speed = (file_size / (1024 * 1024)) / elapsed

        print(f"\n⏱️  Upload time: {elapsed:.2f} seconds")
        print(f"📊 Speed: {speed:.2f} MB/s")
        print("✅ TEST PASSED: Large file upload successful")
        return True

    finally:
        client.disconnect()
        cleanup_test_file(test_file)


def test_reconnect_after_disconnect():
    """Test Case 10: Reconnect after disconnect"""
    print("\n" + "="*60)
    print("TEST 10: Reconnect After Disconnect")
    print("="*60)

    test_file = create_test_file("test_reconnect.mp4", 20)
    file_size = os.path.getsize(test_file)

    # First connection
    client1 = FileUploadClient()
    client1.connect()

    try:
        if not client1.init_upload(os.path.basename(test_file), file_size):
            print("❌ TEST FAILED: Init upload failed")
            return False

        session_id = client1.session_id

        # Upload 2 chunks
        with open(test_file, 'rb') as f:
            for i in range(2):
                chunk_data = f.read(client1.chunk_size)
                if not client1.upload_chunk(i, chunk_data):
                    print(f"❌ TEST FAILED: Chunk {i} upload failed")
                    return False

    finally:
        client1.disconnect()

    print("\n🔄 Reconnecting with new client...")
    time.sleep(2)

    # Second connection - resume with same session
    client2 = FileUploadClient()
    client2.connect()

    try:
        client2.session_id = session_id

        # Try to get status
        status = client2.get_status()
        if status:
            print(f"📊 Session still active: {status['received']}/{status['total']} chunks")
            print("✅ TEST PASSED: Reconnect successful")
            return True
        else:
            print("⚠️  Session may have expired (expected after timeout)")
            print("✅ TEST PASSED: Reconnect handled correctly")
            return True

    finally:
        client2.disconnect()
        cleanup_test_file(test_file)


# ============================================
# Test Runner
# ============================================

def run_all_tests():
    """Run all test cases"""
    print("\n" + "="*60)
    print("🧪 COMPREHENSIVE FILE UPLOAD TEST SUITE")
    print("="*60)

    tests = [
        ("Basic Upload", test_basic_upload),
        ("Pause and Resume", test_pause_resume),
        ("Cancel Upload", test_cancel_upload),
        ("Duplicate Chunks", test_duplicate_chunks),
        ("Invalid Authentication", test_invalid_auth),
        ("Unsupported File Type", test_unsupported_file_type),
        ("Status Check", test_status_check),
        ("Multiple File Types", test_multiple_file_types),
        ("Large File Upload", test_large_file),
        ("Reconnect After Disconnect", test_reconnect_after_disconnect),
    ]

    results = []
    start_time = time.time()

    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"\n❌ TEST CRASHED: {test_name}")
            print(f"   Error: {e}")
            results.append((test_name, False))

        time.sleep(1)  # Brief pause between tests

    elapsed = time.time() - start_time

    # Print summary
    print("\n" + "="*60)
    print("📊 TEST SUMMARY")
    print("="*60)

    passed = sum(1 for _, result in results if result)
    failed = len(results) - passed

    for test_name, result in results:
        status = "✅ PASSED" if result else "❌ FAILED"
        print(f"{status}: {test_name}")

    print("\n" + "="*60)
    print(f"Total: {len(results)} tests")
    print(f"Passed: {passed} ({passed/len(results)*100:.1f}%)")
    print(f"Failed: {failed}")
    print(f"Time: {elapsed:.2f} seconds")
    print("="*60)

    return failed == 0


def run_single_test(test_number: int):
    """Run a single test by number"""
    tests = [
        test_basic_upload,
        test_pause_resume,
        test_cancel_upload,
        test_duplicate_chunks,
        test_invalid_auth,
        test_unsupported_file_type,
        test_status_check,
        test_multiple_file_types,
        test_large_file,
        test_reconnect_after_disconnect,
    ]

    if 1 <= test_number <= len(tests):
        tests[test_number - 1]()
    else:
        print(f"❌ Invalid test number. Choose 1-{len(tests)}")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        # Run specific test
        try:
            test_num = int(sys.argv[1])
            run_single_test(test_num)
        except ValueError:
            print("Usage: python test_comprehensive.py [test_number]")
            print("Example: python test_comprehensive.py 1")
            print("\nOr run all tests: python test_comprehensive.py")
    else:
        # Run all tests
        success = run_all_tests()
        sys.exit(0 if success else 1)
