import React, { useState, useEffect } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ActivityIndicator, View, StyleSheet, Alert } from "react-native";

// Import screens
import SignInScreen from "./screens/SignInScreen";
import RegisterScreen from "./screens/RegisterScreen";
import HomeScreen from "./screens/HomeScreen";

const Stack = createNativeStackNavigator();

// NGROK API base URL
const API_BASE_URL = "https://f8220233c895.ngrok-free.app";

export default function App() {
  const [isLoading, setIsLoading] = useState(true);
  const [sessionToken, setSessionToken] = useState(null);
  const [userEmail, setUserEmail] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await AsyncStorage.getItem("sessionToken");
        const storedEmail = await AsyncStorage.getItem("userEmail");
        setSessionToken(token);
        setUserEmail(storedEmail);
      } catch (error) {
        console.error("Error loading session:", error);
        Alert.alert("Error", "Unable to load session. Please sign in again.");
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const handleLogin = async (token, email) => {
    try {
      await AsyncStorage.setItem("sessionToken", token || "logged-in");
      if (email) {
        await AsyncStorage.setItem("userEmail", email);
      }
      setSessionToken(token || "logged-in");
      setUserEmail(email || null);
    } catch (e) {
      Alert.alert("Error", "Unable to save session.");
    }
  };

  const handleLogout = async () => {
    await AsyncStorage.removeItem("sessionToken");
    await AsyncStorage.removeItem("userEmail");
    setSessionToken(null);
    setUserEmail(null);
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#4A90E2" />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {sessionToken ? (
          <Stack.Screen name="Home">
            {(props) => (
              <HomeScreen
                {...props}
                onLogout={handleLogout}
                userEmail={userEmail}
              />
            )}
          </Stack.Screen>
        ) : (
          <>
            <Stack.Screen name="SignIn">
              {(props) => (
                <SignInScreen
                  {...props}
                  onLogin={handleLogin}
                  apiBaseUrl={API_BASE_URL}
                />
              )}
            </Stack.Screen>
            <Stack.Screen name="Register">
              {(props) => (
                <RegisterScreen {...props} apiBaseUrl={API_BASE_URL} />
              )}
            </Stack.Screen>
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#0A1628",
  },
});
