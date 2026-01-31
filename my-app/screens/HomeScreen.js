import React from "react";
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

export default function HomeScreen({ onLogout, userEmail }) {
  return (
    <LinearGradient
      colors={["#0A1628", "#1A2742", "#0A1628"]}
      style={styles.container}
    >
      <StatusBar style="light" />
      <SafeAreaView style={styles.safeArea}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={styles.greeting}>Welcome back!</Text>
              <Text style={styles.userEmail}>
                {userEmail || "user@securestream.io"}
              </Text>
            </View>
            <TouchableOpacity style={styles.profileButton}>
              <Ionicons name="person-circle" size={40} color="#4A90E2" />
            </TouchableOpacity>
          </View>

          {/* Quick Stats */}
          <View style={styles.statsContainer}>
            <StatCard
              icon="cloud-upload"
              label="Uploaded"
              value="24 GB"
              color="#4A90E2"
            />
            <StatCard
              icon="play-circle"
              label="Streams"
              value="156"
              color="#10B981"
            />
            <StatCard
              icon="document"
              label="Files"
              value="42"
              color="#F59E0B"
            />
          </View>

          {/* Main Actions */}
          <View style={styles.actionsContainer}>
            <Text style={styles.sectionTitle}>Quick Actions</Text>

            <ActionCard
              icon="cloud-upload-outline"
              title="Upload Large File"
              description="Resumable upload for videos & PDFs"
              gradient={["#4A90E2", "#357ABD"]}
            />

            <ActionCard
              icon="play-outline"
              title="My Content Library"
              description="View and stream your files"
              gradient={["#10B981", "#059669"]}
            />

            <ActionCard
              icon="shield-checkmark-outline"
              title="Security Settings"
              description="Manage tokens and access"
              gradient={["#8B5CF6", "#7C3AED"]}
            />
          </View>

          {/* Features */}
          <View style={styles.featuresContainer}>
            <Text style={styles.sectionTitle}>Platform Features</Text>

            <FeatureItem
              icon="lock-closed"
              title="No Direct URLs"
              description="All content protected with short-lived tokens"
            />
            <FeatureItem
              icon="flash"
              title="Instant Streaming"
              description="Video starts in <3 seconds with range requests"
            />
            <FeatureItem
              icon="refresh"
              title="Auto Token Refresh"
              description="Seamless playback without interruption"
            />
            <FeatureItem
              icon="shield"
              title="403 Protection"
              description="Unauthorized access attempts blocked"
            />
          </View>

          {/* Logout Button */}
          <TouchableOpacity style={styles.logoutButton} onPress={onLogout}>
            <Ionicons name="log-out-outline" size={20} color="#EF4444" />
            <Text style={styles.logoutText}>Sign Out</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const StatCard = ({ icon, label, value, color }) => (
  <View style={styles.statCard}>
    <View style={[styles.statIcon, { backgroundColor: `${color}20` }]}>
      <Ionicons name={icon} size={24} color={color} />
    </View>
    <Text style={styles.statValue}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </View>
);

const ActionCard = ({ icon, title, description, gradient }) => (
  <TouchableOpacity style={styles.actionCard}>
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
  </TouchableOpacity>
);

const FeatureItem = ({ icon, title, description }) => (
  <View style={styles.featureItem}>
    <View style={styles.featureIcon}>
      <Ionicons name={icon} size={20} color="#4A90E2" />
    </View>
    <View style={styles.featureContent}>
      <Text style={styles.featureTitle}>{title}</Text>
      <Text style={styles.featureDescription}>{description}</Text>
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
  },
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
  userEmail: {
    fontSize: 14,
    color: "#9CA3AF",
  },
  profileButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(74, 144, 226, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  statsContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 30,
  },
  statCard: {
    flex: 1,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 12,
    padding: 16,
    marginHorizontal: 4,
    borderWidth: 1,
    borderColor: "rgba(74, 144, 226, 0.2)",
    alignItems: "center",
  },
  statIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  statValue: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 12,
    color: "#9CA3AF",
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 16,
  },
  actionsContainer: {
    marginBottom: 30,
  },
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
  actionGradient: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
  },
  actionIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 16,
  },
  actionContent: {
    flex: 1,
  },
  actionTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#FFF",
    marginBottom: 4,
  },
  actionDescription: {
    fontSize: 13,
    color: "rgba(255, 255, 255, 0.8)",
  },
  featuresContainer: {
    marginBottom: 30,
  },
  featureItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "rgba(74, 144, 226, 0.1)",
  },
  featureIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(74, 144, 226, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  featureContent: {
    flex: 1,
  },
  featureTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#FFF",
    marginBottom: 2,
  },
  featureDescription: {
    fontSize: 12,
    color: "#9CA3AF",
  },
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
  logoutText: {
    color: "#EF4444",
    fontSize: 16,
    fontWeight: "600",
  },
});
