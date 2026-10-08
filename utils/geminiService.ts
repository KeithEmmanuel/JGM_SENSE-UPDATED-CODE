import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI();

interface SensorData {
    average_temperature: string;
    major_fluctuation: string;
}

/**
 * 1. DAILY SNAPSHOT: Generates a short notification message focused on piglet positioning.
 */
export async function generatePigletNotification(
    imageBase64: string,
    language: 'English' | 'Tagalog' = 'Tagalog'
): Promise<string> {
    const promptText = `
You are the JGM-Sense monitoring assistant.
Analyze the snapshot of the brooding area and state the piglets' layout position clearly.

Criteria:
- Identify if the piglets are 'Huddling' (magkakadikit), 'Scattered' (magkakahiwalay), or 'Mixed'.
- Output language MUST be ${language}.
- Keep it strictly to 1 or 2 concise sentences designed to be read as a push notification.

Example Tagalog output: "Ang mga biik ay kasalukuyang magkakadikit (huddling) sa ilalim ng ilaw. Siguraduhing sapat ang init sa brooding area."
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    inlineData: {
                        data: imageBase64,
                        mimeType: 'image/jpeg'
                    }
                },
                promptText
            ]
        });

        return response.text || "May bagong kuha na larawan sa brooding area.";
    } catch (error) {
        console.error("Gemini Notification Error:", error);
        return "Nakuha ang larawan mula sa brooding area.";
    }
}

/**
 * 2. WEEKLY SUMMARY: Generates the comprehensive 7-point report at the end of the week.
 */
export async function analyzeWeeklyBroodingReport(
    imageBase64: string, 
    sensorData: SensorData, 
    language: 'English' | 'Tagalog' = 'English'
): Promise<string> {
    const promptText = `
You are the AI-assisted image analysis feature built into the JGM-Sense system.
Analyze the attached image and week-long logs to generate the weekly brooding assessment report.

SYSTEM LOG DATA:
- Recorded Average Temperature: ${sensorData.average_temperature || 'N/A'}
- Recorded Major Fluctuations: ${sensorData.major_fluctuation || 'None'}

USER LANGUAGE PREFERENCE: ${language}

REPORT STRUCTURE & CRITERIA:
1. Number of Piglets: Count the visible piglets. If any are blocked or unclear, note that the count may be incomplete.
2. Piglet Position: Identify if they are 'Huddling' (magkakadikit), 'Scattered' (magkakahiwalay), or 'Mixed'.
3. Piglet Size: State if sizes are uniform or if any noticeably smaller piglets need attention. DO NOT diagnose any medical illnesses.
4. Brooding Area Temperature: Display the provided sensor data.
5. Major Temperature Fluctuation: State the provided fluctuation telemetry in simple terms.
6. Cycle Summary & Prognosis: Provide a short, plain-language assessment of the overall batch based on data. Never use complicated technical/medical jargon.
7. Conditional Congratulatory Message: Check the data. If there are NO major abnormal conditions or major persistent drops/threats, provide a short, encouraging message. If a major issue is recorded in the data (like a steep drop or sick behavior), OMIT this message entirely.

Keep the statements brief, simple, direct, and completely accurate to the language chosen (${language}).
`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                {
                    inlineData: {
                        data: imageBase64,
                        mimeType: 'image/jpeg'
                    }
                },
                promptText
            ]
        });

        return response.text || "No assessment generated.";
    } catch (error) {
        console.error("Gemini Report Error:", error);
        throw error;
    }
}