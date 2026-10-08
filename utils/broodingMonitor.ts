import { addDoc, collection, doc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebaseConfig'; // Adjust relative path if needed
import { analyzeWeeklyBroodingReport, generatePigletNotification } from './geminiService';
import { sendPushNotification } from './localNotifications'; // Ensure this matches localNotifications.ts filename

/**
 * Saves a notification entry into the Firestore 'notifications' collection for in-app history.
 */
async function saveNotificationToFirestore(notification: {
  title: string;
  body: string;
  type: 'alert' | 'weekly_report';
  farmId: string;
}) {
  try {
    await addDoc(collection(db, 'notifications'), {
      ...notification,
      read: false,
      createdAt: serverTimestamp(),
    });
    console.log('💾 Saved alert to Firestore notification history');
  } catch (error) {
    console.error('❌ Failed to save notification to Firestore:', error);
  }
}

/**
 * Listens for new camera snapshots uploaded by the ESP32.
 * Sends an instant push notification with piglet positioning status.
 */
export function startBroodingMonitor(farmId: string) {
  const farmRef = doc(db, 'farms', farmId);

  // Return the listener unsubscribe function for proper lifecycle management
  return onSnapshot(farmRef, async (docSnapshot) => {
    if (!docSnapshot.exists()) return;

    const data = docSnapshot.data();
    const base64Image = data.lastCaptureBase64;

    if (base64Image) {
      console.log('📸 New snapshot detected! Requesting Gemini analysis...');

      // Strip data URL header if present
      const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');

      try {
        // 1. Get notification text from Gemini
        const alertMessage = await generatePigletNotification(cleanBase64, 'Tagalog');
        console.log('🤖 Gemini response:', alertMessage);

        // 2. Trigger local OS push notification
        await sendPushNotification("JGM-Sense Monitoring Alert", alertMessage);
        console.log('🔔 Notification triggered successfully!');

        // 3. Persist notification in Firestore history list
        await saveNotificationToFirestore({
          title: "JGM-Sense Monitoring Alert",
          body: alertMessage,
          type: 'alert',
          farmId,
        });
      } catch (error) {
        console.error('❌ Error during brooding monitoring check:', error);
      }
    }
  });
}

/**
 * Triggers the complete 7-point report at the end of the week.
 */
export async function triggerWeeklyReport(farmId: string, base64Image: string, sensorData: any) {
  try {
    console.log('📊 Generating weekly brooding report...');
    const reportText = await analyzeWeeklyBroodingReport(base64Image, sensorData, 'Tagalog');

    const reportTitle = "Weekly Brooding Report Ready 📊";
    const reportBody = "Your week-end piglet assessment summary has been generated.";

    // 1. Trigger push notification
    await sendPushNotification(reportTitle, reportBody);
    console.log('🔔 Weekly report notification sent!');

    // 2. Persist in Firestore history
    await saveNotificationToFirestore({
      title: reportTitle,
      body: reportBody,
      type: 'weekly_report',
      farmId,
    });

    return reportText;
  } catch (error) {
    console.error('❌ Error generating weekly report:', error);
    throw error;
  }
}