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
<<<<<<< HEAD
const API_BASE_URL = "http://localhost:5000";
=======
const API_BASE_URL = "https://spadiceous-unfocussing-maureen.ngrok-free.dev";
>>>>>>> 1de8355 (bull shit)

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
    try {
      // Get the token to invalidate it on the server
      const token = await AsyncStorage.getItem("sessionToken");

      if (token) {
        // Make the API call to the logout endpoint
        const response = await fetch(`${API_BASE_URL}/logout`, {
          method: "POST", // Or whatever method your API uses for logout
          headers: {
            "Content-Type": "application/json",
            // Assuming your API expects a Bearer token for authentication
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          // If the server fails, we'll still log out the user locally.
          // You can log this for debugging.
          console.error("Server logout failed with status:", response.status);
          // Optionally alert the user, but it's often better to just proceed.
        }
      }
    } catch (error) {
      console.error("Error during server logout:", error);
      // Alert the user that a network error occurred, but still log them out locally.
      Alert.alert(
        "Logout Error",
        "A network error occurred, but you will be logged out from this device.",
      );
    } finally {
      // This part runs whether the API call succeeds or fails,
      // ensuring the user is always logged out on the device side.
      await AsyncStorage.removeItem("sessionToken");
      await AsyncStorage.removeItem("userEmail");

      setSessionToken(null);
      setUserEmail(null);
    }
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
