import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { collection, doc, onSnapshot, orderBy, query, updateDoc } from 'firebase/firestore';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { db } from '../../firebaseConfig'; // Ensure this points to your Firestore instance

interface NotificationItem {
  id: string;
  title: string;
  body: string;
  type: string;
  read: boolean;
  createdAt?: any;
  pdfUrl?: string;
  iconColor?: string;
  iconBg?: string;
}

export default function NotificationScreen() {
  const router = useRouter();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Direct physical back button to Account screen
  const handleBack = () => {
    router.replace('/(tabs)/Account');
  };

  useFocusEffect(
    React.useCallback(() => {
      const onBackPress = () => {
        handleBack();
        return true;
      };

      const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => subscription.remove();
    }, [])
  );

  // --- 1. LISTEN TO FIRESTORE NOTIFICATIONS ---
  useEffect(() => {
    const q = query(
      collection(db, 'notifications'),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const parsedNotifications: NotificationItem[] = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          const type = data.type || 'alert';
          const defaultCategory = getCategoryColor(type);

          return {
            id: docSnap.id,
            title: data.title || 'System Notification',
            body: data.body || '',
            type: type,
            read: data.read !== undefined ? data.read : false,
            createdAt: data.createdAt,
            pdfUrl: data.pdfUrl,
            iconColor: data.iconColor || defaultCategory.color,
            iconBg: data.iconBg || defaultCategory.bg,
          };
        });

        setNotifications(parsedNotifications);
        setLoading(false);
      },
      (error) => {
        console.error('Error fetching Firestore notifications:', error);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  // --- 2. MARK NOTIFICATION AS READ ON TAP ---
  const handlePressNotification = async (item: NotificationItem) => {
    if (!item.read) {
      try {
        const docRef = doc(db, 'notifications', item.id);
        await updateDoc(docRef, { read: true });
      } catch (error) {
        console.error('Failed to update unread status in Firestore:', error);
      }
    }

    // Action router: open external PDF or redirect to Report screen
    if (item.pdfUrl) {
      Linking.openURL(item.pdfUrl);
    } else if (item.type === 'weekly_report' || item.type === 'Report') {
      router.push('/Report');
    }
  };

  // Icon styling mapping based on notification type
  const getCategoryColor = (type: string) => {
    switch (type) {
      case 'Temperature':
        return { color: '#E53935', bg: '#FFEBEE' };
      case 'weekly_report':
      case 'Report':
        return { color: '#1E88E5', bg: '#E3F2FD' };
      case 'Added Record':
        return { color: '#43A047', bg: '#E8F5E9' };
      case 'alert':
      default:
        return { color: '#F7A8B8', bg: '#FCF3F5' };
    }
  };

  const formatTime = (createdAt: any) => {
    if (!createdAt) return 'Just now';
    
    let date: Date;
    if (createdAt.toDate) {
      date = createdAt.toDate();
    } else if (typeof createdAt === 'number') {
      date = new Date(createdAt);
    } else {
      date = new Date();
    }

    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const renderItem = ({ item }: { item: NotificationItem }) => {
    const isUnread = !item.read;

    return (
      <TouchableOpacity
        style={[styles.card, isUnread && styles.unreadCard]}
        onPress={() => handlePressNotification(item)}
        activeOpacity={0.7}
      >
        <View style={[styles.iconContainer, { backgroundColor: item.iconBg || '#FCF3F5' }]}>
          <MaterialCommunityIcons
            name={
              item.type === 'Temperature'
                ? 'thermometer-alert'
                : item.type === 'weekly_report' || item.type === 'Report'
                ? 'file-document'
                : item.type === 'override'
                ? 'tune-variant'
                : 'bell'
            }
            size={22}
            color={item.iconColor || '#F7A8B8'}
          />
        </View>

        <View style={styles.textContainer}>
          <View style={styles.cardHeader}>
            <Text style={styles.title}>{item.title}</Text>
            {isUnread && <View style={styles.unreadBadge} />}
          </View>
          <Text style={styles.body}>{item.body}</Text>
          <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleBack} style={styles.backButton}>
          <Ionicons name="arrow-back" size={28} color="#F7A8B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Notifications</Text>
      </View>

      {/* Content */}
      {loading ? (
        <ActivityIndicator size="large" color="#F7A8B8" style={{ marginTop: 50 }} />
      ) : notifications.length > 0 ? (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
        />
      ) : (
        <View style={styles.emptyContainer}>
          <MaterialCommunityIcons name="bell-off-outline" size={60} color="#CCC" />
          <Text style={styles.emptyText}>No notifications yet</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FCF3F5', paddingTop: 50 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 15 },
  backButton: { padding: 5, marginRight: 10 },
  headerTitle: { fontSize: 24, fontWeight: '700', color: '#333' },
  listContent: { paddingHorizontal: 20, paddingBottom: 30 },
  card: {
    flexDirection: 'row',
    backgroundColor: '#FFF',
    padding: 16,
    borderRadius: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#F0E0E5',
  },
  unreadCard: {
    borderColor: '#F7A8B8',
    backgroundColor: '#FFFFFF',
  },
  iconContainer: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  textContainer: { flex: 1 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 15, fontWeight: '700', color: '#333', flex: 1 },
  unreadBadge: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#E53935', marginLeft: 6 },
  body: { fontSize: 13, color: '#666', marginTop: 4 },
  time: { fontSize: 11, color: '#999', marginTop: 6 },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 100 },
  emptyText: { color: '#888', marginTop: 10, fontSize: 16 },
});