import React, { useState, useEffect, useRef } from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  Alert,
  ActivityIndicator,
  FlatList,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import * as FileSystem from "expo-file-system";
import { Video } from "expo-av";
import { Audio } from "expo-av";

/* ---------------- CONSTANTS ---------------- */
const API_BASE_URL = "https://27f7876d45e6.ngrok-free.app"; // Update this with your server IP

/* ---------------- UPLOAD BANDWIDTH PROBE ---------------- */
async function measureUploadNetwork() {
  const UPLOAD_SIZE = 256 * 1024; // 256 KB
  const payload = new Uint8Array(UPLOAD_SIZE);

  const start = Date.now();

  try {
    await fetch("https://httpbin.org/post", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: payload,
    });

    const timeMs = Date.now() - start;
    const bandwidthMbps = (UPLOAD_SIZE * 8) / (timeMs / 1000) / (1024 * 1024);

    return {
      rttMs: Math.max(timeMs, 20),
      bandwidthMbps: Math.max(bandwidthMbps, 1),
    };
  } catch (error) {
    console.error("Bandwidth measurement failed:", error);
    return {
      rttMs: 100,
      bandwidthMbps: 5,
    };
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

  const MIN_CHUNK = 5 * 1024 * 1024; // 5 MB (S3 minimum)
  const MAX_CHUNK = 100 * 1024 * 1024; // 100 MB

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
  constructor(authToken, apiBaseUrl) {
    this.authToken = authToken;
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
    console.log("✅ Ready to upload via HTTP");
    return Promise.resolve();
  }

  async initializeUpload(file, config) {
    this.file = file;
    this.uploadConfig = config;
    this.currentChunk = 0;
    this.uploadedChunks.clear();

    const fileName = file.name || "file";
    const totalChunks = config.totalChunks;
    const chunkSize = config.chunkSize;
    const fileSize = file.size || file.fileSize;

    try {
      const response = await fetch(`${this.apiBaseUrl}/upload/init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          filename: fileName,
          file_size: fileSize,
          total_chunks: totalChunks,
          chunk_size: chunkSize,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to initialize upload");
      }

      const data = await response.json();
      this.sessionID = data.session_id;
      this.s3Key = data.s3_key;

      console.log("✅ Session initialized:", this.sessionID);
      console.log("📁 S3 Key:", this.s3Key);

      this.startChunkUpload();
    } catch (error) {
      console.error("❌ Failed to initialize upload:", error);
      if (this.onError) {
        this.onError(error.message);
      }
    }
  }

  async startChunkUpload() {
    this.currentChunk = 0;
    this.uploadNextChunk();
  }

  async uploadNextChunk() {
    if (this.isPaused) return;

    if (this.currentChunk >= this.uploadConfig.totalChunks) {
      console.log("All chunks uploaded, finalizing...");
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
        encoding: FileSystem.EncodingType.Base64,
        position: start,
        length: actualChunkSize,
      });

      console.log(
        `📦 Uploading chunk ${this.currentChunk + 1}/${this.uploadConfig.totalChunks}`,
      );

      const formData = new FormData();
      formData.append("session_id", this.sessionID);
      formData.append("chunk_index", this.currentChunk.toString());
      formData.append("total_chunks", this.uploadConfig.totalChunks.toString());

      const blob = await fetch(
        `data:application/octet-stream;base64,${chunkData}`,
      ).then((r) => r.blob());
      formData.append("chunk", blob, `chunk_${this.currentChunk}`);

      const response = await fetch(`${this.apiBaseUrl}/upload/chunk`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.authToken}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to upload chunk");
      }

      const data = await response.json();

      this.uploadedChunks.add(this.currentChunk);
      const progress = data.progress || 0;

      console.log(
        `✅ Chunk ${this.currentChunk + 1} uploaded (${progress.toFixed(1)}%)`,
      );

      if (this.onProgress) {
        this.onProgress(progress);
      }

      if (data.completed) {
        console.log("🎉 Upload complete!");
        if (this.onComplete) {
          this.onComplete(data.s3_key, data.file_size);
        }
        return;
      }

      this.currentChunk++;
      setTimeout(() => this.uploadNextChunk(), 10);
    } catch (error) {
      console.error("Error uploading chunk:", error);
      if (this.onError) {
        this.onError(`Failed to upload chunk: ${error.message}`);
      }
    }
  }

  async finalizeUpload() {
    try {
      const response = await fetch(`${this.apiBaseUrl}/upload/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.authToken}`,
        },
        body: JSON.stringify({
          session_id: this.sessionID,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Failed to finalize upload");
      }

      const data = await response.json();
      const s3Key = data.s3_key || this.s3Key;
      const fileSize = data.file_size || this.file.size || this.file.fileSize;

      console.log("🎉 Upload complete!");

      if (this.onComplete) {
        this.onComplete(s3Key, fileSize);
      }
    } catch (error) {
      console.error("❌ Failed to finalize upload:", error);
      if (this.onError) {
        this.onError(error.message);
      }
    }
  }

  pause() {
    this.isPaused = true;
  }

  resume() {
    this.isPaused = false;
    this.uploadNextChunk();
  }

  disconnect() {
    this.isPaused = true;
  }
}

/* ---------------- FILE BROWSER COMPONENT ---------------- */
function FileBrowser({ accessToken, apiBaseUrl, onClose }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [streamingFile, setStreamingFile] = useState(null);
  const [streamingToken, setStreamingToken] = useState(null);

  useEffect(() => {
    loadFiles();
  }, []);

  const loadFiles = async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/files`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to load files");
      }

      const data = await response.json();
      setFiles(data.files || []);
    } catch (error) {
      console.error("Error loading files:", error);
      Alert.alert("Error", "Failed to load files");
    } finally {
      setLoading(false);
    }
  };

  const requestStreamingToken = async (s3Key) => {
    try {
      const response = await fetch(`${apiBaseUrl}/files/streaming-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ s3_key: s3Key }),
      });

      if (!response.ok) {
        throw new Error("Failed to get streaming token");
      }

      const data = await response.json();
      return data.token;
    } catch (error) {
      console.error("Error getting streaming token:", error);
      Alert.alert("Error", "Failed to get streaming access");
      return null;
    }
  };

  const playFile = async (file) => {
    const token = await requestStreamingToken(file.key);
    if (!token) return;

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

  const getFileIcon = (key) => {
    const type = getFileType(key);
    switch (type) {
      case "video":
        return "videocam";
      case "audio":
        return "musical-notes";
      case "image":
        return "image";
      case "pdf":
        return "document-text";
      default:
        return "document";
    }
  };

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(2) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  };

  const getFileName = (key) => {
    const parts = key.split("/");
    return parts[parts.length - 1];
  };

  if (streamingFile && streamingToken) {
    const streamUrl = `${apiBaseUrl}/stream?token=${streamingToken}`;
    const fileType = getFileType(streamingFile.key);

    return (
      <LinearGradient
        colors={["#0A1628", "#1A2742", "#0A1628"]}
        style={styles.container}
      >
        <StatusBar style="light" />
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.streamContainer}>
            <View style={styles.streamHeader}>
              <TouchableOpacity
                onPress={() => {
                  setStreamingFile(null);
                  setStreamingToken(null);
                }}
              >
                <Ionicons name="arrow-back" size={24} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.streamTitle}>
                {getFileName(streamingFile.key)}
              </Text>
              <View style={{ width: 24 }} />
            </View>

            {fileType === "video" && (
              <Video
                source={{ uri: streamUrl }}
                style={styles.videoPlayer}
                useNativeControls
                resizeMode="contain"
                shouldPlay
              />
            )}

            {fileType === "audio" && (
              <View style={styles.audioPlayer}>
                <Ionicons name="musical-notes" size={64} color="#4A90E2" />
                <Text style={styles.audioTitle}>
                  {getFileName(streamingFile.key)}
                </Text>
                <Video
                  source={{ uri: streamUrl }}
                  useNativeControls
                  shouldPlay
                />
              </View>
            )}

            {fileType === "image" && (
              <Image source={{ uri: streamUrl }} style={styles.imageViewer} />
            )}

            <View style={styles.fileDetails}>
              <Text style={styles.fileDetailLabel}>File Size:</Text>
              <Text style={styles.fileDetailValue}>
                {formatFileSize(streamingFile.size)}
              </Text>
            </View>
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
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#4A90E2" />
            <Text style={styles.loadingText}>Loading files...</Text>
          </View>
        ) : files.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="folder-open-outline" size={64} color="#9CA3AF" />
            <Text style={styles.emptyText}>No files yet</Text>
            <Text style={styles.emptySubtext}>Upload your first file</Text>
          </View>
        ) : (
          <FlatList
            data={files}
            keyExtractor={(item, index) => index.toString()}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.fileItem}
                onPress={() => playFile(item)}
              >
                <View style={styles.fileIcon}>
                  <Ionicons
                    name={getFileIcon(item.key)}
                    size={28}
                    color="#4A90E2"
                  />
                </View>
                <View style={styles.fileInfo}>
                  <Text style={styles.fileName}>{getFileName(item.key)}</Text>
                  <Text style={styles.fileSize}>
                    {formatFileSize(item.size)}
                  </Text>
                </View>
                <Ionicons name="play-circle" size={32} color="#10B981" />
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
export default function HomeScreen({ onLogout, userEmail, accessToken }) {
  const [showUpload, setShowUpload] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [file, setFile] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const uploaderRef = useRef(null);

  useEffect(() => {
    if (accessToken) {
      uploaderRef.current = new HTTPUploader(accessToken, API_BASE_URL);
    }
  }, [accessToken]);

  const pickDocument = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ["application/pdf", "audio/*", "video/*"],
      copyToCacheDirectory: true,
    });

    if (!result.canceled) {
      const selectedFile = result.assets[0];
      setFile(selectedFile);
      measureAndCalculate(selectedFile);
    }
  };

  const pickImage = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permission Required", "Please grant photo library access");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 1,
    });

    if (!result.canceled) {
      const selectedFile = result.assets[0];
      setFile(selectedFile);
      measureAndCalculate(selectedFile);
    }
  };

  const measureAndCalculate = async (selectedFile) => {
    const fileSize = selectedFile.size || selectedFile.fileSize;
    if (!fileSize) return;

    setLoading(true);
    setConfig(null);

    try {
      const cpuCores = 4;
      const freeMemoryMB = 2048;

      console.log("📊 Measuring upload bandwidth...");
      const net = await measureUploadNetwork();
      console.log("📊 Bandwidth:", net.bandwidthMbps.toFixed(2), "Mbps");

      const calculatedConfig = calculateInitialConfig({
        fileSizeBytes: fileSize,
        bandwidthMbps: net.bandwidthMbps,
        rttMs: net.rttMs,
        cpuCores,
        freeMemoryMB,
      });

      setConfig(calculatedConfig);
    } catch (error) {
      console.error("Error calculating config:", error);
      Alert.alert("Error", "Failed to calculate upload configuration");
    } finally {
      setLoading(false);
    }
  };

  const startUpload = async () => {
    if (!file || !config) {
      Alert.alert("Error", "Please select a file first");
      return;
    }

    if (!accessToken) {
      Alert.alert("Error", "No access token found. Please login again.");
      return;
    }

    if (!uploaderRef.current) {
      uploaderRef.current = new HTTPUploader(accessToken, API_BASE_URL);
    }

    const uploader = uploaderRef.current;

    setUploading(true);
    setUploadProgress(0);

    try {
      await uploader.connect();

      uploader.onProgress = (progress) => {
        setUploadProgress(progress);
      };

      uploader.onComplete = async (s3Key, fileSize) => {
        setUploading(false);

        Alert.alert(
          "Success",
          `File uploaded successfully!\n\nSize: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`,
          [
            {
              text: "OK",
              onPress: () => {
                uploader.disconnect();
                setShowUpload(false);
                setFile(null);
                setConfig(null);
              },
            },
          ],
        );
      };

      uploader.onError = (error) => {
        setUploading(false);
        Alert.alert("Error", error);
        uploader.disconnect();
      };

      await uploader.initializeUpload(file, config);
    } catch (error) {
      setUploading(false);
      Alert.alert("Error", `Connection failed: ${error.message}`);
    }
  };

  const cancelUpload = () => {
    Alert.alert("Cancel Upload", "Are you sure you want to cancel?", [
      { text: "No", style: "cancel" },
      {
        text: "Yes",
        style: "destructive",
        onPress: () => {
          if (uploaderRef.current) {
            uploaderRef.current.disconnect();
          }
          setUploading(false);
          setUploadProgress(0);
        },
      },
    ]);
  };

  if (showBrowser) {
    return (
      <FileBrowser
        accessToken={accessToken}
        apiBaseUrl={API_BASE_URL}
        onClose={() => setShowBrowser(false)}
      />
    );
  }

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
              <TouchableOpacity
                onPress={() => !uploading && setShowUpload(false)}
              >
                <Ionicons name="arrow-back" size={24} color="#FFF" />
              </TouchableOpacity>
              <Text style={styles.uploadTitle}>Upload File</Text>
              <View style={{ width: 24 }} />
            </View>

            {!file && (
              <View style={styles.pickerContainer}>
                <TouchableOpacity
                  style={styles.pickerButton}
                  onPress={pickDocument}
                >
                  <Ionicons name="document-outline" size={32} color="#4A90E2" />
                  <Text style={styles.pickerButtonText}>
                    Pick PDF / Audio / Video
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.pickerButton}
                  onPress={pickImage}
                >
                  <Ionicons name="image-outline" size={32} color="#10B981" />
                  <Text style={styles.pickerButtonText}>Pick Image</Text>
                </TouchableOpacity>
              </View>
            )}

            {file && (
              <View style={styles.fileInfo}>
                <Ionicons name="document" size={48} color="#4A90E2" />
                <Text style={styles.fileName}>{file.name || "Image"}</Text>
                <Text style={styles.fileSize}>
                  {((file.size || file.fileSize) / (1024 * 1024)).toFixed(2)} MB
                </Text>
                <Text style={styles.fileType}>{file.mimeType || "image"}</Text>
              </View>
            )}

            {loading && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#4A90E2" />
                <Text style={styles.loadingText}>
                  Measuring upload bandwidth...
                </Text>
              </View>
            )}

            {config && !uploading && (
              <View style={styles.configContainer}>
                <Text style={styles.configTitle}>✅ Upload Configuration</Text>

                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>Bandwidth:</Text>
                  <Text style={styles.configValue}>
                    {config.bandwidthMbps.toFixed(2)} Mbps
                  </Text>
                </View>

                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>Chunk Size:</Text>
                  <Text style={styles.configValue}>
                    {(config.chunkSize / (1024 * 1024)).toFixed(2)} MB
                  </Text>
                </View>

                <View style={styles.configRow}>
                  <Text style={styles.configLabel}>Total Chunks:</Text>
                  <Text style={styles.configValue}>{config.totalChunks}</Text>
                </View>

                <TouchableOpacity
                  style={styles.startButton}
                  onPress={startUpload}
                >
                  <Ionicons name="cloud-upload" size={20} color="#FFF" />
                  <Text style={styles.startButtonText}>Start Upload</Text>
                </TouchableOpacity>
              </View>
            )}

            {uploading && (
              <View style={styles.uploadingContainer}>
                <ActivityIndicator size="large" color="#10B981" />
                <Text style={styles.uploadingText}>
                  Uploading... {uploadProgress.toFixed(1)}%
                </Text>

                <View style={styles.progressBarContainer}>
                  <View
                    style={[
                      styles.progressBar,
                      { width: `${uploadProgress}%` },
                    ]}
                  />
                </View>

                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={cancelUpload}
                >
                  <Text style={styles.cancelButtonText}>Cancel Upload</Text>
                </TouchableOpacity>
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
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <View>
              <Text style={styles.greeting}>Welcome back!</Text>
              <Text style={styles.userEmail}>{userEmail || "User"}</Text>
            </View>
            <TouchableOpacity style={styles.profileButton}>
              <Ionicons name="person-circle" size={40} color="#4A90E2" />
            </TouchableOpacity>
          </View>

          <View style={styles.actionsContainer}>
            <Text style={styles.sectionTitle}>Quick Actions</Text>

            <TouchableOpacity onPress={() => setShowUpload(true)}>
              <ActionCard
                icon="cloud-upload-outline"
                title="Upload File"
                description="Resumable upload for large files"
                gradient={["#4A90E2", "#357ABD"]}
              />
            </TouchableOpacity>

            <TouchableOpacity onPress={() => setShowBrowser(true)}>
              <ActionCard
                icon="play-outline"
                title="My Files"
                description="Browse and stream your content"
                gradient={["#10B981", "#059669"]}
              />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.logoutButton} onPress={onLogout}>
            <Ionicons name="log-out-outline" size={20} color="#EF4444" />
            <Text style={styles.logoutText}>Sign Out</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const ActionCard = ({ icon, title, description, gradient }) => (
  <View style={styles.actionCard}>
    <LinearGradient
      colors={[...gradient, `${gradient[0]}E0`]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.actionGradient}
    >
      <View style={styles.actionIcon}>
        <Ionicons name={icon} size={28} color="#FFF" />
      </View>
      <View style={styles.actionContent}>
        <Text style={styles.actionTitle}>{title}</Text>
        <Text style={styles.actionDescription}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#FFF" />
    </LinearGradient>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scrollContent: { padding: 20 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 30,
  },
  greeting: {
    fontSize: 28,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 4,
  },
  userEmail: { fontSize: 14, color: "#9CA3AF" },
  profileButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(74, 144, 226, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 16,
  },
  actionsContainer: { marginBottom: 30 },
  actionCard: {
    borderRadius: 12,
    marginBottom: 12,
    overflow: "hidden",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  actionGradient: { flexDirection: "row", alignItems: "center", padding: 16 },
  actionIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  actionContent: { flex: 1 },
  actionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 4,
  },
  actionDescription: { fontSize: 13, color: "rgba(255, 255, 255, 0.8)" },
  logoutButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    gap: 8,
  },
  logoutText: { color: "#EF4444", fontSize: 16, fontWeight: "600" },
  uploadHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 30,
  },
  uploadTitle: { fontSize: 20, fontWeight: "bold", color: "#FFF" },
  pickerContainer: { gap: 16, marginBottom: 20 },
  pickerButton: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    borderWidth: 2,
    borderColor: "rgba(74, 144, 226, 0.3)",
    borderStyle: "dashed",
  },
  pickerButtonText: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 12,
  },
  fileInfo: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    padding: 24,
    alignItems: "center",
    marginBottom: 20,
    borderWidth: 1,
    borderColor: "rgba(74, 144, 226, 0.2)",
  },
  fileName: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFF",
    marginTop: 12,
    textAlign: "center",
  },
  fileSize: { fontSize: 16, color: "#4A90E2", marginTop: 8 },
  fileType: { fontSize: 14, color: "#9CA3AF", marginTop: 4 },
  loadingContainer: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    padding: 32,
    alignItems: "center",
    marginBottom: 20,
  },
  loadingText: {
    color: "#FFF",
    fontSize: 16,
    fontWeight: "600",
    marginTop: 16,
  },
  configContainer: {
    backgroundColor: "rgba(74, 144, 226, 0.1)",
    borderRadius: 12,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(74, 144, 226, 0.3)",
  },
  configTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 16,
  },
  configRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  configLabel: { fontSize: 14, color: "#9CA3AF" },
  configValue: { fontSize: 14, fontWeight: "600", color: "#FFF" },
  startButton: {
    backgroundColor: "#4A90E2",
    borderRadius: 8,
    padding: 16,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
  },
  startButtonText: { color: "#FFF", fontSize: 16, fontWeight: "bold" },
  uploadingContainer: {
    backgroundColor: "rgba(16, 185, 129, 0.1)",
    borderRadius: 12,
    padding: 32,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(16, 185, 129, 0.3)",
  },
  uploadingText: {
    color: "#FFF",
    fontSize: 20,
    fontWeight: "bold",
    marginTop: 16,
  },
  progressBarContainer: {
    width: "100%",
    height: 8,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 4,
    marginTop: 20,
    overflow: "hidden",
  },
  progressBar: { height: "100%", backgroundColor: "#10B981", borderRadius: 4 },
  cancelButton: {
    marginTop: 20,
    padding: 12,
    borderWidth: 1,
    borderColor: "#EF4444",
    borderRadius: 8,
  },
  cancelButtonText: { color: "#EF4444", fontSize: 14, fontWeight: "600" },
  browserHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
  },
  browserTitle: { fontSize: 20, fontWeight: "bold", color: "#FFF" },
  fileList: { padding: 20 },
  fileItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "rgba(74, 144, 226, 0.2)",
  },
  fileIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(74, 144, 226, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
  },
  emptyText: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#FFF",
    marginTop: 16,
  },
  emptySubtext: { fontSize: 14, color: "#9CA3AF", marginTop: 8 },
  streamContainer: { flex: 1 },
  streamHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
  },
  streamTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#FFF",
    flex: 1,
    textAlign: "center",
  },
  videoPlayer: { width: "100%", height: 300, backgroundColor: "#000" },
  audioPlayer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 40,
  },
  audioTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#FFF",
    marginTop: 16,
    textAlign: "center",
  },
  imageViewer: { width: "100%", height: 400, resizeMode: "contain" },
  fileDetails: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 20,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    margin: 20,
  },
  fileDetailLabel: { fontSize: 14, color: "#9CA3AF" },
  fileDetailValue: { fontSize: 14, fontWeight: "600", color: "#FFF" },
});
