#import <Foundation/Foundation.h>

// Imported as a Swift OptionSet that @objc delegate requirements can carry,
// like the real UserNotifications type.
typedef NS_OPTIONS(NSUInteger, UNNotificationPresentationOptions) {
  UNNotificationPresentationOptionNone = 0,
};
