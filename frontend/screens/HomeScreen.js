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
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system/legacy";
import { Video, ResizeMode } from "expo-av";
import { WebView } from "react-native-webview";

/* ---------------- CONSTANTS ---------------- */
// ⚠️ IMPORTANT: Update this URL every time you restart ngrok ⚠️
const API_BASE_URL = "https://27f7876d45e6.ngrok-free.app";

/* ---------------- UPLOAD BANDWIDTH PROBE ---------------- */
async function measureUploadNetwork() {
  const UPLOAD_SIZE = 256 * 1024; // 256 KB
  const payload = new Uint8Array(UPLOAD_SIZE);
  const start = Date.now();
  try {
    await fetch("https://httpbin.org/post", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: payload,
    });
    const timeMs = Date.now() - start;
    const bandwidthMbps = (UPLOAD_SIZE * 8) / (timeMs / 1000) / (1024 * 1024);
    return {
      rttMs: Math.max(timeMs, 20),
      bandwidthMbps: Math.max(bandwidthMbps, 1),
    };
  } catch (error) {
    return { rttMs: 100, bandwidthMbps: 5 };
  }
}

/* ---------------- CHUNK OPTIMIZER ---------------- */
function calculateInitialConfig({
  fileSizeBytes,
  bandwidthMbps,
  rttMs,
  cpuCores,
  freeMemoryMB,
}) {
  const bandwidthBps = (bandwidthMbps * 1024 * 1024) / 8;
  const rttSec = rttMs / 1000;
  let chunkSize = bandwidthBps * rttSec * 2;
  const MIN_CHUNK = 5 * 1024 * 1024;
  const MAX_CHUNK = 100 * 1024 * 1024;
  chunkSize = Math.max(MIN_CHUNK, Math.min(chunkSize, MAX_CHUNK));
  const connCpu = cpuCores * 2;
  const connMem = freeMemoryMB / (chunkSize / (1024 * 1024));
  const connNet = bandwidthBps / chunkSize;
  const connections = Math.max(
    1,
    Math.floor(Math.min(connCpu, connMem, connNet, 16)),
  );
  return {
    chunkSize: Math.floor(chunkSize),
    connections,
    totalChunks: Math.ceil(fileSizeBytes / chunkSize),
    bandwidthBps,
    bandwidthMbps,
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
    this.s3Key = "";
    this.uploadedChunks = new Set();
  }

  async connect() {
    return Promise.resolve();
  }

  async initializeUpload(file, config) {
    this.file = file;
    this.uploadConfig = config;
    this.currentChunk = 0;
    this.uploadedChunks.clear();
    this.isPaused = false;
    const fileName = file.name || "file";
    const fileSize = file.size || file.fileSize;

    const payload = {
      email_id: this.emailID,
      filename: fileName,
      file_size: fileSize,
      total_chunks: config.totalChunks,
      chunk_size: config.chunkSize,
    };

    try {
      const response = await fetch(`${this.apiBaseUrl}/upload/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const responseText = await response.text();
      if (!response.ok) throw new Error(`Init failed: ${responseText}`);
      const data = JSON.parse(responseText);
      this.sessionID = data.session_id;
      this.s3Key = data.s3_key;
      this.startChunkUpload();
    } catch (error) {
      if (this.onError) this.onError(error.message);
    }
  }

  async startChunkUpload() {
    this.currentChunk = 0;
    this.uploadNextChunk();
  }

  async uploadNextChunk() {
    if (this.isPaused) return;
    if (this.currentChunk >= this.uploadConfig.totalChunks) {
      await this.finalizeUpload();
      return;
    }
    const fileUri = this.file.uri;
    const fileSize = this.file.size || this.file.fileSize;
    const chunkSize = this.uploadConfig.chunkSize;
    const start = this.currentChunk * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);
    const actualChunkSize = end - start;

    try {
      const chunkData = await FileSystem.readAsStringAsync(fileUri, {
        encoding: "base64",
        position: start,
        length: actualChunkSize,
      });

      const formData = new FormData();
      formData.append("email_id", this.emailID);
      formData.append("session_id", this.sessionID);
      formData.append("chunk_index", this.currentChunk.toString());
      formData.append("total_chunks", this.uploadConfig.totalChunks.toString());

      const blob = await fetch(
        `data:application/octet-stream;base64,${chunkData}`,
      ).then((r) => r.blob());
      formData.append("chunk", blob, `chunk_${this.currentChunk}`);

      const response = await fetch(`${this.apiBaseUrl}/upload/chunk`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Chunk upload failed");
      const responseText = await response.text();
      const data = JSON.parse(responseText);

      this.uploadedChunks.add(this.currentChunk);
      const progress = data.progress || 0;
      if (this.onProgress) this.onProgress(progress);

      if (data.completed) {
        if (this.onComplete) this.onComplete(data.s3_key, data.file_size);
        return;
      }
      this.currentChunk++;
      setTimeout(() => this.uploadNextChunk(), 10);
    } catch (error) {
      if (this.onError)
        this.onError(`Failed to upload chunk: ${error.message}`);
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
      if (!response.ok) throw new Error("Finalize failed");
      const data = await response.json();
      if (this.onComplete) this.onComplete(data.s3_key, data.file_size || 0);
    } catch (error) {
      if (this.onError) this.onError(error.message);
    }
  }

  async cancel() {
    this.isPaused = true;
    try {
      await fetch(`${this.apiBaseUrl}/upload/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email_id: this.emailID,
          session_id: this.sessionID,
        }),
      });
    } catch (e) {
      console.warn("Cancel failed", e);
    }
    this.disconnect();
  }

  pause() {
    this.isPaused = true;
  }
  resume() {
    if (this.isPaused) {
      this.isPaused = false;
      this.uploadNextChunk();
    }
  }
  disconnect() {
    this.isPaused = true;
    this.file = null;
    this.sessionID = "";
  }
}

/* ---------------- FILE BROWSER COMPONENT ---------------- */
function FileBrowser({ emailID, apiBaseUrl, onClose }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [streamingFile, setStreamingFile] = useState(null);
  const [streamingToken, setStreamingToken] = useState(null);

  useEffect(() => {
    loadFiles();
  }, []);

  useEffect(() => {
    let interval;
    if (streamingFile && streamingToken) {
      interval = setInterval(
        async () => {
          const newToken = await requestStreamingToken(streamingFile.key);
          if (newToken) setStreamingToken(newToken);
        },
        4 * 60 * 1000,
      );
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [streamingFile, streamingToken]);

  const loadFiles = async () => {
    try {
      const response = await fetch(
        `${apiBaseUrl}/files?email_id=${encodeURIComponent(emailID)}`,
      );
      if (!response.ok) throw new Error("Failed to load files");
      const data = await response.json();
      setFiles(data.files || []);
    } catch (error) {
      Alert.alert("Error", "Failed to load files. Check API URL.");
    } finally {
      setLoading(false);
    }
  };

  const requestStreamingToken = async (s3Key) => {
    try {
      const response = await fetch(`${apiBaseUrl}/files/streaming-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_id: emailID, s3_key: s3Key }),
      });
      if (!response.ok) throw new Error("Failed to get token");
      const data = await response.json();
      return data.token;
    } catch (error) {
      return null;
    }
  };

  const playFile = async (file) => {
    const token = await requestStreamingToken(file.key);
    if (!token) {
      Alert.alert("Error", "Unable to authorize playback");
      return;
    }
    setStreamingToken(token);
    setStreamingFile(file);
  };

  const getFileType = (key) => {
    const ext = key.toLowerCase().split(".").pop();
    if (["mp4", "mov", "avi", "mkv"].includes(ext)) return "video";
    if (["mp3", "wav", "m4a"].includes(ext)) return "audio";
    if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "image";
    if (ext === "pdf") return "pdf";
    return "file";
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  };

  if (streamingFile && streamingToken) {
    const streamUrl = `${apiBaseUrl}/stream?token=${streamingToken}`;
    const fileType = getFileType(streamingFile.key);

    console.log(`🎥 Streaming: ${fileType} from ${streamUrl}`);

    // Android PDF Hack: Use Google Docs Viewer
    const isAndroidPdf = Platform.OS === "android" && fileType === "pdf";
    const finalUri = isAndroidPdf
      ? `https://docs.google.com/gview?embedded=true&url=${encodeURIComponent(streamUrl)}`
      : streamUrl;

    return (
      <LinearGradient colors={["#000", "#111"]} style={styles.container}>
        <StatusBar hidden />
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.streamHeader}>
            <TouchableOpacity
              onPress={() => {
                setStreamingFile(null);
                setStreamingToken(null);
              }}
              style={styles.backButton}
            >
              <Ionicons name="close" size={28} color="#FFF" />
            </TouchableOpacity>
            <Text style={styles.streamTitle} numberOfLines={1}>
              {streamingFile.key.split("/").pop()}
            </Text>
          </View>

          <View style={styles.playerContainer}>
            {fileType === "video" && (
              <Video
                source={{ uri: streamUrl }}
                style={styles.fullscreenPlayer}
                useNativeControls
                resizeMode={ResizeMode.CONTAIN}
                shouldPlay
                onError={(e) =>
                  Alert.alert("Video Error", `Could not play video. Code: ${e}`)
                }
              />
            )}

            {fileType === "audio" && (
              <View style={styles.audioPlayer}>
                <Ionicons name="musical-notes" size={80} color="#4A90E2" />
                <Video
                  source={{ uri: streamUrl }}
                  useNativeControls
                  shouldPlay
                />
              </View>
            )}

            {fileType === "image" && (
              <Image
                source={{ uri: streamUrl }}
                style={styles.fullscreenPlayer}
                resizeMode="contain"
              />
            )}

            {fileType === "pdf" && (
              <WebView
                source={{ uri: finalUri }}
                style={{ flex: 1, backgroundColor: "#fff" }}
                scalesPageToFit={true}
                onError={(e) => console.log("WebView Error", e)}
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

        {loading ? (
          <ActivityIndicator
            size="large"
            color="#4A90E2"
            style={{ marginTop: 50 }}
          />
        ) : files.length === 0 ? (
          <View
            style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
          >
            <Text style={{ color: "#FFF" }}>No files found for this user.</Text>
          </View>
        ) : (
          <FlatList
            data={files}
            keyExtractor={(item) => item.key}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.fileItem}
                onPress={() => playFile(item)}
              >
                <View style={styles.fileIcon}>
                  <Ionicons
                    name={
                      getFileType(item.key) === "video"
                        ? "videocam"
                        : getFileType(item.key) === "pdf"
                          ? "document-text"
                          : "document"
                    }
                    size={24}
                    color="#4A90E2"
                  />
                </View>
                <View style={styles.fileInfo}>
                  <Text style={styles.fileName}>
                    {item.key.split("/").pop()}
                  </Text>
                  <Text style={styles.fileSize}>
                    {formatFileSize(item.size)}
                  </Text>
                </View>
                <Ionicons
                  name="play-circle-outline"
                  size={28}
                  color="#10B981"
                />
              </TouchableOpacity>
            )}
            contentContainerStyle={styles.fileList}
          />
        )}
      </SafeAreaView>
    </LinearGradient>
  );
}

/* ---------------- MAIN HOME SCREEN COMPONENT ---------------- */
export default function HomeScreen({ onLogout, userEmail }) {
  const [showUpload, setShowUpload] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [file, setFile] = useState(null);
  const [config, setConfig] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const uploaderRef = useRef(null);

  useEffect(() => {
    if (userEmail)
      uploaderRef.current = new HTTPUploader(userEmail, API_BASE_URL);
  }, [userEmail]);

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "*/*",
      copyToCacheDirectory: true,
    });
    if (!result.canceled) {
      setFile(result.assets[0]);
      measureAndCalculate(result.assets[0]);
    }
  };

  const measureAndCalculate = async (selectedFile) => {
    try {
      const net = await measureUploadNetwork();
      const calculatedConfig = calculateInitialConfig({
        fileSizeBytes: selectedFile.size,
        bandwidthMbps: net.bandwidthMbps,
        rttMs: net.rttMs,
        cpuCores: 4,
        freeMemoryMB: 2048,
      });
      setConfig(calculatedConfig);
    } catch (e) {
      Alert.alert("Error", "Config calculation failed");
    }
  };

  const startUpload = async () => {
    if (!file || !config || !uploaderRef.current) return;
    setUploading(true);
    setIsPaused(false);
    setUploadProgress(0);
    const uploader = uploaderRef.current;
    uploader.onProgress = (progress) => setUploadProgress(progress);
    uploader.onComplete = () => {
      setUploading(false);
      Alert.alert("Success", "Upload completed!");
      setFile(null);
      setConfig(null);
      setShowUpload(false);
    };
    uploader.onError = (err) => {
      setUploading(false);
      Alert.alert("Error", err);
    };
    await uploader.initializeUpload(file, config);
  };

  const togglePause = () => {
    if (uploaderRef.current) {
      if (isPaused) {
        uploaderRef.current.resume();
        setIsPaused(false);
      } else {
        uploaderRef.current.pause();
        setIsPaused(true);
      }
    }
  };

  const cancelUpload = () => {
    Alert.alert("Cancel", "Stop upload?", [
      { text: "No", style: "cancel" },
      {
        text: "Yes",
        style: "destructive",
        onPress: () => {
          if (uploaderRef.current) uploaderRef.current.cancel();
          setUploading(false);
          setIsPaused(false);
          setUploadProgress(0);
        },
      },
    ]);
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
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={styles.uploadHeader}>
              <TouchableOpacity onPress={() => setShowUpload(false)}>
                <Ionicons name="arrow-back" size={24} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.uploadTitle}>Upload</Text>
              <View style={{ width: 24 }} />
            </View>

            {!file ? (
              <TouchableOpacity
                style={styles.pickerButton}
                onPress={pickDocument}
              >
                <Ionicons
                  name="cloud-upload-outline"
                  size={48}
                  color="#4A90E2"
                />
                <Text style={styles.pickerButtonText}>Select File</Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.fileInfo}>
                <Text style={styles.fileName}>{file.name}</Text>
                <Text style={styles.fileSize}>
                  {(file.size / (1024 * 1024)).toFixed(2)} MB
                </Text>
              </View>
            )}

            {config && !uploading && (
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
                  {isPaused ? "Paused" : "Uploading..."}{" "}
                  {uploadProgress.toFixed(1)}%
                </Text>
                <View style={styles.progressBarContainer}>
                  <View
                    style={[
                      styles.progressBar,
                      {
                        width: `${uploadProgress}%`,
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
                    <Ionicons
                      name={isPaused ? "play" : "pause"}
                      size={24}
                      color="#FFF"
                    />
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
                    <Ionicons name="close-circle" size={24} color="#FFF" />
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
            <Text style={styles.menuSubtitle}>Stream Video & View PDF</Text>
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
    marginBottom: 30,
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
  },
  pickerButtonText: { color: "#4A90E2", fontSize: 18, marginTop: 12 },
  fileInfo: { alignItems: "center", padding: 20 },
  fileName: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFF",
    textAlign: "center",
  },
  fileSize: { color: "#9CA3AF", marginTop: 8 },
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
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: "center",
    gap: 8,
  },
  controlButtonText: { color: "#FFF", fontWeight: "600" },
  browserHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 20,
    alignItems: "center",
  },
  browserTitle: { fontSize: 20, fontWeight: "bold", color: "#FFF" },
  fileList: { padding: 20 },
  fileItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
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
  audioPlayer: { alignItems: "center", gap: 20 },
});
