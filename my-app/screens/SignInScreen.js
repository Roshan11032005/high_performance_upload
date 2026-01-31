import React, { useState } from "react";
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

export default function SignInScreen({ navigation, onLogin, apiBaseUrl }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSignIn = async () => {
    if (!email || !password) {
      Alert.alert("Error", "Please fill in all fields");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `username=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
      });

      // Success on 200 or redirect (302/301)
      if (res.status === 200 || res.status === 302 || res.status === 301) {
        // Try to read JWT from Set-Cookie (if available)
        const setCookie =
          res.headers.get("set-cookie") || res.headers.get("Set-Cookie");
        let token = null;
        if (setCookie) {
          const match = setCookie.match(/jwt_token=([^;]+)/);
          if (match) token = match[1];
        }

        await onLogin(token || "logged-in", email);
        return;
      }

      if (res.status === 401) {
        let message = "Invalid email or password";
        try {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const data = await res.json();
            message = data?.message || message;
          }
        } catch {}
        Alert.alert("Error", message);
        return;
      }

      // Other errors
      const text = await res.text();
      Alert.alert(
        "Login failed",
        `Status ${res.status}. ${text?.slice(0, 200) || ""}`,
      );
    } catch (error) {
      Alert.alert(
        "Network Error",
        "Unable to reach the server. Please try again.",
      );
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient
      colors={["#0A1628", "#1A2742", "#0A1628"]}
      style={styles.container}
    >
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.iconContainer}>
              <Ionicons name="cloud-upload" size={50} color="#4A90E2" />
            </View>
            <Text style={styles.title}>SecureStream</Text>
            <Text style={styles.subtitle}>PB05 Challenge Platform</Text>
            <Text style={styles.description}>
              Secure, high-performance video & PDF streaming
            </Text>
          </View>

          {/* Form */}
          <View style={styles.formContainer}>
            {/* Email Input */}
            <View style={styles.inputWrapper}>
              <View style={styles.inputIconContainer}>
                <Ionicons name="mail-outline" size={20} color="#4A90E2" />
              </View>
              <TextInput
                style={styles.input}
                placeholder="Email Address"
                placeholderTextColor="#6B7280"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            {/* Password Input */}
            <View style={styles.inputWrapper}>
              <View style={styles.inputIconContainer}>
                <Ionicons
                  name="lock-closed-outline"
                  size={20}
                  color="#4A90E2"
                />
              </View>
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#6B7280"
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
              />
              <TouchableOpacity
                style={styles.eyeIcon}
                onPress={() => setShowPassword(!showPassword)}
              >
                <Ionicons
                  name={showPassword ? "eye-outline" : "eye-off-outline"}
                  size={20}
                  color="#6B7280"
                />
              </TouchableOpacity>
            </View>

            {/* Forgot Password */}
            <TouchableOpacity style={styles.forgotPassword}>
              <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
            </TouchableOpacity>

            {/* Sign In Button */}
            <TouchableOpacity
              style={[styles.signInButton, loading && styles.buttonDisabled]}
              onPress={handleSignIn}
              disabled={loading}
            >
              <LinearGradient
                colors={["#4A90E2", "#357ABD"]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.gradientButton}
              >
                {loading ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <>
                    <Text style={styles.signInButtonText}>Sign In</Text>
                    <Ionicons name="arrow-forward" size={20} color="#FFF" />
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Register Link */}
            <View style={styles.registerContainer}>
              <Text style={styles.registerText}>Don't have an account? </Text>
              <TouchableOpacity onPress={() => navigation.navigate("Register")}>
                <Text style={styles.registerLink}>Create Account</Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Features */}
          <View style={styles.featuresContainer}>
            <FeatureItem icon="shield-checkmark" text="Secure Authentication" />
            <FeatureItem icon="cloud-upload" text="Multi-GB File Upload" />
            <FeatureItem icon="play-circle" text="Instant Streaming" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const FeatureItem = ({ icon, text }) => (
  <View style={styles.featureItem}>
    <Ionicons name={icon} size={16} color="#4A90E2" />
    <Text style={styles.featureText}>{text}</Text>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 40,
  },
  header: {
    alignItems: "center",
    marginBottom: 40,
  },
  iconContainer: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: "rgba(74, 144, 226, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
    borderWidth: 2,
    borderColor: "rgba(74, 144, 226, 0.3)",
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: "#4A90E2",
    fontWeight: "600",
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: "#9CA3AF",
    textAlign: "center",
    paddingHorizontal: 20,
  },
  formContainer: {
    marginBottom: 30,
  },
  inputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: "rgba(74, 144, 226, 0.2)",
    height: 56,
  },
  inputIconContainer: {
    paddingLeft: 16,
    paddingRight: 12,
  },
  input: {
    flex: 1,
    color: "#FFF",
    fontSize: 16,
    paddingRight: 16,
  },
  eyeIcon: {
    paddingHorizontal: 16,
  },
  forgotPassword: {
    alignSelf: "flex-end",
    marginBottom: 24,
  },
  forgotPasswordText: {
    color: "#4A90E2",
    fontSize: 14,
    fontWeight: "600",
  },
  signInButton: {
    borderRadius: 12,
    overflow: "hidden",
    elevation: 4,
    shadowColor: "#4A90E2",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  gradientButton: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 16,
    gap: 8,
  },
  signInButtonText: {
    color: "#FFF",
    fontSize: 18,
    fontWeight: "bold",
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 30,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
  },
  dividerText: {
    color: "#6B7280",
    paddingHorizontal: 16,
    fontSize: 14,
    fontWeight: "600",
  },
  registerContainer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
  },
  registerText: {
    color: "#9CA3AF",
    fontSize: 15,
  },
  registerLink: {
    color: "#4A90E2",
    fontSize: 15,
    fontWeight: "bold",
  },
  featuresContainer: {
    marginTop: 20,
  },
  featureItem: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    paddingHorizontal: 8,
  },
  featureText: {
    color: "#9CA3AF",
    fontSize: 14,
    marginLeft: 12,
  },
});
