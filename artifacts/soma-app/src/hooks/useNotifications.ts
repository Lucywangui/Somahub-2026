import { Capacitor } from "@capacitor/core";
import {
  LocalNotifications,
  type LocalNotificationSchema,
} from "@capacitor/local-notifications";
import {
  AndroidSettings,
  IOSSettings,
  NativeSettings,
} from "capacitor-native-settings";

const ENABLED_KEY = "somaHubNotificationsEnabled";
const LAST_REMINDER_KEY = "somaHubLastDailyReminder";
const DAILY_REMINDER_ID = 1800;
const TEST_NOTIFICATION_ID = 1801;

export const isNotificationsEnabled =
  typeof localStorage !== "undefined" &&
  localStorage.getItem(ENABLED_KEY) === "true";

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled));
  } catch (error) {
    console.error("Could not save notification preference:", error);
  }

  if (!enabled && Capacitor.isNativePlatform()) {
    void LocalNotifications.cancel({
      notifications: [
        { id: DAILY_REMINDER_ID },
        { id: TEST_NOTIFICATION_ID },
      ],
    }).catch((error) => {
      console.error("Could not cancel notifications:", error);
    });
  }
}

export async function openNotificationSettings(): Promise<void> {
  try {
    if (Capacitor.getPlatform() === "android") {
      await NativeSettings.openAndroid({
        option: AndroidSettings.AppNotification,
      });
      return;
    }

    if (Capacitor.getPlatform() === "ios") {
      await NativeSettings.openIOS({
        option: IOSSettings.AppNotification,
      });
      return;
    }

    window.alert(
      "Open your device or browser settings and allow notifications for SOMA HUB.",
    );
  } catch (error) {
    console.error("Could not open notification settings:", error);
  }
}

async function hasNotificationPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    );
  }

  try {
    const permission = await LocalNotifications.checkPermissions();
    return permission.display === "granted";
  } catch (error) {
    console.error("Could not check notification permission:", error);
    return false;
  }
}

async function scheduleDailyReminder(name?: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (!(await hasNotificationPermission())) return;

  const learner = name?.trim();
  const body = learner
    ? `${learner}, it's time to practise and keep your streak alive! 💛`
    : "It's time to practise and keep your streak alive! 💛";

  const notification: LocalNotificationSchema = {
    id: DAILY_REMINDER_ID,
    title: "🐦 Time to learn!",
    body,
    schedule: {
      on: { hour: 18, minute: 0 },
      repeats: true,
      allowWhileIdle: true,
    },
    extra: { type: "daily-study-reminder" },
  };

  try {
    const pending = await LocalNotifications.getPending();
    const exists = pending.notifications.some(
      (item) => item.id === DAILY_REMINDER_ID,
    );

    if (!exists) {
      await LocalNotifications.schedule({
        notifications: [notification],
      });
    }
  } catch (error) {
    console.error("Could not schedule daily reminder:", error);
  }
}

export async function requestAndEnableNotifications(): Promise<boolean> {
  try {
    if (!Capacitor.isNativePlatform()) {
      if (typeof Notification === "undefined") return false;

      let permission = Notification.permission;
      if (permission === "default") {
        permission = await Notification.requestPermission();
      }

      if (permission !== "granted") {
        await openNotificationSettings();
        return false;
      }

      setNotificationsEnabled(true);
      return true;
    }

    let permission = await LocalNotifications.checkPermissions();

    if (permission.display !== "granted") {
      permission = await LocalNotifications.requestPermissions();
    }

    if (permission.display !== "granted") {
      await openNotificationSettings();
      return false;
    }

    setNotificationsEnabled(true);
    return true;
  } catch (error) {
    console.error("Could not enable notifications:", error);
    return false;
  }
}

export async function showTestNotification(name?: string): Promise<void> {
  const learner = name?.trim();

  if (!Capacitor.isNativePlatform()) {
    if (
      typeof Notification !== "undefined" &&
      Notification.permission === "granted"
    ) {
      new Notification("🐦 SOMA HUB", {
        body: learner
          ? `Hi ${learner}! Your study reminders are on. 💛`
          : "Your study reminders are on. 💛",
      });
    }
    return;
  }

  if (!(await hasNotificationPermission())) return;

  try {
    await LocalNotifications.cancel({
      notifications: [{ id: TEST_NOTIFICATION_ID }],
    });

    await LocalNotifications.schedule({
      notifications: [
        {
          id: TEST_NOTIFICATION_ID,
          title: "🐦 SOMA HUB",
          body: learner
            ? `Hi ${learner}! Your study reminders are on. 💛`
            : "Your study reminders are on. 💛",
          schedule: {
            at: new Date(Date.now() + 2000),
            allowWhileIdle: true,
          },
        },
      ],
    });
  } catch (error) {
    console.error("Could not show test notification:", error);
  }
}

export async function checkAndShowDailyReminder(
  name?: string,
): Promise<void> {
  let enabled = false;

  try {
    enabled = localStorage.getItem(ENABLED_KEY) === "true";
  } catch (error) {
    console.error("Could not read notification preference:", error);
  }

  if (!enabled) return;

  if (Capacitor.isNativePlatform()) {
    await scheduleDailyReminder(name);
    return;
  }

  if (
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    const today = new Date().toLocaleDateString();
    let lastReminder: string | null = null;

    try {
      lastReminder = localStorage.getItem(LAST_REMINDER_KEY);
    } catch {
      return;
    }

    if (lastReminder !== today) {
      const learner = name?.trim();

      new Notification("🐦 Time to learn!", {
        body: learner
          ? `${learner}, practise today and keep your streak alive! 💛`
          : "Practise today and keep your streak alive! 💛",
      });

      try {
        localStorage.setItem(LAST_REMINDER_KEY, today);
      } catch (error) {
        console.error("Could not save reminder date:", error);
      }
    }
  }
}
