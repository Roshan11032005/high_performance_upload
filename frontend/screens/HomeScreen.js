import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  FlatList,
  Image,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Video, ResizeMode } from "expo-av";
import * as Sharing from "expo-sharing";

/* ---------------- CONSTANTS ---------------- */
// ⚠️ IMPORTANT: Update this URL every time you restart ngrok ⚠️
const API_BASE_URL = "https://27f7876d45e6.ngrok-free.app";

/* ---------------- CONFIG UTILS ---------------- */
function calculateInitialConfig({ fileSizeBytes }) {
  // Use a fixed safe chunk size (5MB) to ensure S3 compatibility
  const chunkSize = 5 * 1024 * 1024;
  return {
    chunkSize,
    totalChunks: Math.ceil(fileSizeBytes / chunkSize),
  };
}

/* ---------------- HTTP UPLOADER CLASS ---------------- */
class HTTPUploader {
  constructor(emailID, apiBaseUrl) {
    this.emailID = emailID;
    this.apiBaseUrl = apiBaseUrl;
    this.sessionID = "";
    this.uploadConfig = null;
    this.file = null;
    this.onProgress = null;
    this.onComplete = null;
    this.onError = null;
    this.currentChunk = 0;
    this.isPaused = false;
  }

  async initializeUpload(file, config) {
    this.file = file;
    this.uploadConfig = config;
    this.currentChunk = 0;
    this.isPaused = false;

    try {
      const response = await fetch(`${this.apiBaseUrl}/upload/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email_id: this.emailID,
          filename: file.name,
          file_size: file.size,
          total_chunks: config.totalChunks,
          chunk_size: config.chunkSize,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Init failed");

      this.sessionID = data.session_id;
      this.uploadNextChunk();
    } catch (error) {
      if (this.onError) this.onError(error.message);
    }
  }

  // ---------------------------------------------------------
  // ✅ FIXED: uploadNextChunk using Temporary Files logic
  // ---------------------------------------------------------
  async uploadNextChunk() {
    if (this.isPaused) return;
    if (this.currentChunk >= this.uploadConfig.totalChunks) {
      this.finalizeUpload();
      return;
    }

    const start = this.currentChunk * this.uploadConfig.chunkSize;
    const end = Math.min(start + this.uploadConfig.chunkSize, this.file.size);
    const length = end - start;
    let tempChunkPath = null;

    try {
      // 1. Read chunk as Base64
      const chunkData = await FileSystem.readAsStringAsync(this.file.uri, {
        encoding: "base64",
        position: start,
        length: length,
      });

      // 2. Write to temp file
      tempChunkPath = `${FileSystem.cacheDirectory}chunk_${this.sessionID}_${this.currentChunk}.bin`;
      await FileSystem.writeAsStringAsync(tempChunkPath, chunkData, {
        encoding: "base64",
      });

      // 3. Create FormData with URI
      const formData = new FormData();
      formData.append("email_id", this.emailID);
      formData.append("session_id", this.sessionID);
      formData.append("chunk_index", this.currentChunk.toString());

      formData.append("chunk", {
        uri: tempChunkPath,
        name: `chunk_${this.currentChunk}.bin`,
        type: "application/octet-stream",
      });

      const response = await fetch(`${this.apiBaseUrl}/upload/chunk`, {
        method: "POST",
        body: formData,
        headers: { Accept: "application/json" },
      });

      // 4. Cleanup
      await FileSystem.deleteAsync(tempChunkPath, { idempotent: true });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Upload failed: ${errText}`);
      }

      const progressPercent =
        ((this.currentChunk + 1) / this.uploadConfig.totalChunks) * 100;
      if (this.onProgress) this.onProgress(progressPercent);

      this.currentChunk++;
      setTimeout(() => this.uploadNextChunk(), 10);
    } catch (e) {
      if (tempChunkPath)
        await FileSystem.deleteAsync(tempChunkPath, { idempotent: true }).catch(
          () => {},
        );
      if (this.onError) this.onError(e.message);
    }
  }

  async finalizeUpload() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/upload/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email_id: this.emailID,
          session_id: this.sessionID,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Finalize failed");
      if (this.onComplete) this.onComplete();
    } catch (e) {
      if (this.onError) this.onError(e.message);
    }
  }

  cancel() {
    this.isPaused = true;
  }
  resume() {
    if (this.isPaused) {
      this.isPaused = false;
      this.uploadNextChunk();
    }
  }
  pause() {
    this.isPaused = true;
  }
}

/* ---------------- FILE BROWSER (DOWNLOAD & VIEW) ---------------- */
function FileBrowser({ emailID, apiBaseUrl, onClose }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [viewingFile, setViewingFile] = useState(null);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      const response = await fetch(
        `${apiBaseUrl}/files?email_id=${encodeURIComponent(emailID)}`,
      );
      const data = await response.json();
      setFiles(data.files || []);
    } catch (error) {
      Alert.alert("Error", "Failed to load files");
    } finally {
      setLoading(false);
    }
  };

  const downloadAndPreview = async (file) => {
    setDownloading(true);
    try {
      const tokenResp = await fetch(`${apiBaseUrl}/files/streaming-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_id: emailID, s3_key: file.key }),
      });
      if (!tokenResp.ok) throw new Error("Failed to get token");

      const { token } = await tokenResp.json();
      const fileName = file.key.split("/").pop();
      const localUri = FileSystem.cacheDirectory + `${Date.now()}_${fileName}`;

      await FileSystem.downloadAsync(
        `${apiBaseUrl}/stream?token=${token}`,
        localUri,
      );

      const ext = fileName.toLowerCase().split(".").pop();
      if (["mp4", "mov", "m4v", "jpg", "png", "jpeg", "webp"].includes(ext)) {
        setViewingFile({
          uri: localUri,
          type: ["jpg", "png", "jpeg", "webp"].includes(ext)
            ? "image"
            : "video",
          name: fileName,
        });
      } else {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(localUri);
        } else {
          Alert.alert("Error", "Sharing not available");
        }
      }
    } catch (error) {
      Alert.alert("Error", "Failed to download");
    } finally {
      setDownloading(false);
    }
  };

  if (viewingFile) {
    return (
      <LinearGradient colors={["#000", "#111"]} style={styles.container}>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.streamHeader}>
            <TouchableOpacity
              onPress={() => setViewingFile(null)}
              style={styles.backButton}
            >
              <Ionicons name="close" size={28} color="#FFF" />
            </TouchableOpacity>
            <Text style={styles.streamTitle}>{viewingFile.name}</Text>
          </View>
          <View style={styles.playerContainer}>
            {viewingFile.type === "video" ? (
              <Video
                source={{ uri: viewingFile.uri }}
                style={styles.fullscreenPlayer}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay
              />
            ) : (
              <Image
                source={{ uri: viewingFile.uri }}
                style={styles.fullscreenPlayer}
                resizeMode="contain"
              />
            )}
          </View>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={["#0A1628", "#1A2742", "#0A1628"]}
      style={styles.container}
    >
      <StatusBar style="light" />
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.browserHeader}>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="arrow-back" size={24} color="#FFF" />
          </TouchableOpacity>
          <Text style={styles.browserTitle}>My Files</Text>
          <TouchableOpacity onPress={loadFiles}>
            <Ionicons name="refresh" size={24} color="#FFF" />
          </TouchableOpacity>
        </View>
        {downloading && (
          <View style={styles.loadingOverlay}>
            <View style={styles.loadingBox}>
              <ActivityIndicator size="large" color="#4A90E2" />
              <Text style={styles.loadingText}>Opening Preview...</Text>
            </View>
          </View>
        )}
        <FlatList
          data={files}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={styles.fileItem}
              onPress={() => downloadAndPreview(item)}
            >
              <View style={styles.fileIcon}>
                <Ionicons name="document-text" size={24} color="#4A90E2" />
              </View>
              <View style={styles.fileInfo}>
                <Text style={styles.fileName}>{item.key.split("/").pop()}</Text>
                <Text style={styles.fileSize}>
                  {(item.size / 1024 / 1024).toFixed(2)} MB
                </Text>
              </View>
              <Ionicons name="play-circle-outline" size={28} color="#10B981" />
            </TouchableOpacity>
          )}
        />
      </SafeAreaView>
    </LinearGradient>
  );
}

/* ---------------- MAIN SCREEN ---------------- */
export default function HomeScreen({ onLogout, userEmail }) {
  const [showUpload, setShowUpload] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const uploaderRef = useRef(null);

  useEffect(() => {
    if (userEmail)
      uploaderRef.current = new HTTPUploader(userEmail, API_BASE_URL);
  }, [userEmail]);

  const pickFile = async () => {
    const res = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      copyToCacheDirectory: true,
    });
    if (!res.canceled) setFile(res.assets[0]);
  };

  const startUpload = async () => {
    if (!file || !uploaderRef.current) return;
    setUploading(true);
    setProgress(0);
    setIsPaused(false);
    const config = calculateInitialConfig({ fileSizeBytes: file.size });

    uploaderRef.current.onProgress = (p) => setProgress(p);
    uploaderRef.current.onComplete = () => {
      setUploading(false);
      Alert.alert("Success", "Upload Completed!");
      setFile(null);
      setShowUpload(false);
    };
    uploaderRef.current.onError = (e) => {
      setUploading(false);
      Alert.alert("Error", e);
    };
    await uploaderRef.current.initializeUpload(file, config);
  };

  const togglePause = () => {
    if (uploaderRef.current) {
      isPaused ? uploaderRef.current.resume() : uploaderRef.current.pause();
      setIsPaused(!isPaused);
    }
  };

  const cancelUpload = () => {
    if (uploaderRef.current) uploaderRef.current.cancel();
    setUploading(false);
    setFile(null);
  };

  /* --- HELPER: RENDER LOCAL PREVIEW --- */
  const renderLocalPreview = () => {
    if (!file) return null;
    const isImage =
      file.mimeType?.startsWith("image/") ||
      ["jpg", "jpeg", "png", "webp"].some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      );
    const isVideo =
      file.mimeType?.startsWith("video/") ||
      ["mp4", "mov", "m4v"].some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      );

    if (isImage) {
      return (
        <Image
          source={{ uri: file.uri }}
          style={styles.localPreviewMedia}
          resizeMode="contain"
        />
      );
    }
    if (isVideo) {
      return (
        <Video
          source={{ uri: file.uri }}
          style={styles.localPreviewMedia}
          useNativeControls
          resizeMode={ResizeMode.CONTAIN}
          isLooping
        />
      );
    }
    // Default Icon for non-media files
    return (
      <Ionicons
        name="document-text-outline"
        size={64}
        color="#FFF"
        style={{ marginBottom: 16 }}
      />
    );
  };

  if (showBrowser)
    return (
      <FileBrowser
        emailID={userEmail}
        apiBaseUrl={API_BASE_URL}
        onClose={() => setShowBrowser(false)}
      />
    );

  if (showUpload) {
    return (
      <LinearGradient
        colors={["#0A1628", "#1A2742", "#0A1628"]}
        style={styles.container}
      >
        <StatusBar style="light" />
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.uploadHeader}>
            <TouchableOpacity onPress={() => setShowUpload(false)}>
              <Ionicons name="arrow-back" size={24} color="#FFF" />
            </TouchableOpacity>
            <Text style={styles.uploadTitle}>Upload File</Text>
            <View style={{ width: 24 }} />
          </View>

          <ScrollView contentContainerStyle={styles.scrollContent}>
            {!file ? (
              <TouchableOpacity style={styles.pickerButton} onPress={pickFile}>
                <Ionicons
                  name="cloud-upload-outline"
                  size={48}
                  color="#4A90E2"
                />
                <Text style={styles.pickerButtonText}>Select File</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.fileInfoBox}>
                {/* PREVIEW RENDERED HERE */}
                {renderLocalPreview()}

                <Text style={styles.fileName}>{file.name}</Text>
                <Text style={styles.fileSize}>
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </Text>

                {!uploading && (
                  <TouchableOpacity
                    onPress={pickFile}
                    style={styles.changeFileButton}
                  >
                    <Text style={styles.changeFileText}>Change File</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {file && !uploading && (
              <TouchableOpacity
                style={styles.startButton}
                onPress={startUpload}
              >
                <Text style={styles.startButtonText}>Start Upload</Text>
              </TouchableOpacity>
            )}

            {uploading && (
              <View style={styles.uploadingContainer}>
                <Text style={styles.uploadingText}>
                  {isPaused ? "Paused" : "Uploading..."} {progress.toFixed(0)}%
                </Text>
                <View style={styles.progressBarContainer}>
                  <View
                    style={[
                      styles.progressBar,
                      {
                        width: `${progress}%`,
                        backgroundColor: isPaused ? "#F59E0B" : "#10B981",
                      },
                    ]}
                  />
                </View>
                <View style={styles.controlsRow}>
                  <TouchableOpacity
                    style={[
                      styles.controlButton,
                      { backgroundColor: isPaused ? "#10B981" : "#F59E0B" },
                    ]}
                    onPress={togglePause}
                  >
                    <Text style={styles.controlButtonText}>
                      {isPaused ? "Resume" : "Pause"}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.controlButton,
                      { backgroundColor: "#EF4444" },
                    ]}
                    onPress={cancelUpload}
                  >
                    <Text style={styles.controlButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={["#0A1628", "#1A2742", "#0A1628"]}
      style={styles.container}
    >
      <StatusBar style="light" />
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.header}>
          <Text style={styles.greeting}>Hello, {userEmail}</Text>
          <TouchableOpacity onPress={onLogout}>
            <Ionicons name="log-out-outline" size={24} color="#EF4444" />
          </TouchableOpacity>
        </View>
        <View style={styles.menuContainer}>
          <TouchableOpacity
            style={styles.menuCard}
            onPress={() => setShowUpload(true)}
          >
            <Ionicons name="cloud-upload" size={40} color="#4A90E2" />
            <Text style={styles.menuTitle}>Upload File</Text>
            <Text style={styles.menuSubtitle}>Resumable & Large Files</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.menuCard}
            onPress={() => setShowBrowser(true)}
          >
            <Ionicons name="play-circle" size={40} color="#10B981" />
            <Text style={styles.menuTitle}>My Files</Text>
            <Text style={styles.menuSubtitle}>Download & View</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scrollContent: { padding: 20 },
  header: {
    padding: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  greeting: { fontSize: 22, fontWeight: "bold", color: "#FFF" },
  menuContainer: { padding: 20, gap: 16 },
  menuCard: {
    backgroundColor: "rgba(255,255,255,0.1)",
    padding: 24,
    borderRadius: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  menuTitle: { fontSize: 18, fontWeight: "bold", color: "#FFF", marginTop: 12 },
  menuSubtitle: { color: "#9CA3AF", marginTop: 4 },
  uploadHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
  },
  uploadTitle: { fontSize: 20, fontWeight: "bold", color: "#FFF" },
  pickerButton: {
    height: 200,
    borderWidth: 2,
    borderColor: "#4A90E2",
    borderStyle: "dashed",
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(74, 144, 226, 0.1)",
    marginBottom: 20,
  },
  pickerButtonText: { color: "#4A90E2", fontSize: 18, marginTop: 12 },
  fileInfoBox: {
    alignItems: "center",
    padding: 20,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 12,
  },
  fileName: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#FFF",
    textAlign: "center",
    marginTop: 10,
  },
  fileSize: { color: "#9CA3AF", marginTop: 4 },
  changeFileButton: {
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 6,
  },
  changeFileText: { color: "#FFF", fontSize: 12 },
  startButton: {
    backgroundColor: "#4A90E2",
    padding: 16,
    borderRadius: 12,
    alignItems: "center",
    marginTop: 20,
  },
  startButtonText: { color: "#FFF", fontSize: 18, fontWeight: "bold" },
  uploadingContainer: { marginTop: 30 },
  uploadingText: { color: "#FFF", marginBottom: 10, textAlign: "center" },
  progressBarContainer: {
    height: 8,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 4,
    overflow: "hidden",
  },
  progressBar: { height: "100%" },
  controlsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
    marginTop: 20,
  },
  controlButton: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
  },
  controlButtonText: { color: "#FFF", fontWeight: "600" },
  browserHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 20,
    alignItems: "center",
  },
  browserTitle: { fontSize: 20, fontWeight: "bold", color: "#FFF" },
  fileItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    marginHorizontal: 20,
  },
  fileIcon: {
    width: 48,
    height: 48,
    backgroundColor: "rgba(74,144,226,0.1)",
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  fileInfo: { flex: 1 },
  streamHeader: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    backgroundColor: "#000",
  },
  backButton: { padding: 8 },
  streamTitle: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "bold",
    marginLeft: 16,
    flex: 1,
  },
  playerContainer: {
    flex: 1,
    backgroundColor: "#000",
    justifyContent: "center",
  },
  fullscreenPlayer: { width: "100%", height: "100%" },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 999,
  },
  loadingBox: {
    backgroundColor: "#1A2742",
    padding: 24,
    borderRadius: 12,
    alignItems: "center",
  },
  loadingText: { color: "#FFF", marginTop: 12 },
  localPreviewMedia: {
    width: "100%",
    height: 200,
    borderRadius: 8,
    backgroundColor: "#000",
    marginBottom: 16,
  },
});
