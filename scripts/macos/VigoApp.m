#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

static NSString *const VigoStorageBookmarkKey = @"VIGOStorageSecurityBookmark";

@interface VigoWebView : WKWebView
- (void)lockContextMenus;
@end

@implementation VigoWebView

- (void)lockContextMenus {
  [self lockContextMenusInView:self];
}

- (void)lockContextMenusInView:(NSView *)view {
  NSMenu *emptyMenu = [[NSMenu alloc] initWithTitle:@""];
  emptyMenu.autoenablesItems = NO;
  view.menu = emptyMenu;

  for (NSView *subview in view.subviews) {
    [self lockContextMenusInView:subview];
  }
}

- (void)viewDidMoveToWindow {
  [super viewDidMoveToWindow];
  [self lockContextMenus];
}

- (void)addSubview:(NSView *)view {
  [super addSubview:view];
  [self lockContextMenusInView:view];
}

- (NSMenu *)menuForEvent:(NSEvent *)event {
  return nil;
}

- (BOOL)performKeyEquivalent:(NSEvent *)event {
  NSEventModifierFlags modifierFlags = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
  NSString *key = event.charactersIgnoringModifiers.lowercaseString ?: @"";

  if ([key isEqualToString:@"r"] && (modifierFlags & NSEventModifierFlagCommand) != 0) {
    return YES;
  }

  return [super performKeyEquivalent:event];
}

@end

@interface VigoAppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSTask *serverTask;
@property(nonatomic, strong) NSPipe *serverOutput;
@property(nonatomic, strong) NSPipe *serverError;
@property(nonatomic, strong) NSMutableString *outputBuffer;
@property(nonatomic, strong) NSURL *runtimeOriginURL;
@property(nonatomic, assign) BOOL didLoadServer;
@property(nonatomic, assign) NSTimeInterval navigationStartedAt;
@property(nonatomic, strong) NSURL *authorizedStorageURL;
- (BOOL)automaticCacheCleanupEnabled;
- (void)clearWebCacheWithCompletion:(void (^)(void))completion;
@end

@implementation VigoAppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
  [self installApplicationMenu];
  void (^launchApplication)(void) = ^{
    [self createMainWindow];
    [self authorizeStorageAndStartServer];
  };
  if ([self automaticCacheCleanupEnabled]) {
    [self clearWebCacheWithCompletion:launchApplication];
  } else {
    launchApplication();
  }
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return YES;
}

- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)app {
  return YES;
}

- (void)applicationWillTerminate:(NSNotification *)notification {
  [self stopServer];
  [self.authorizedStorageURL stopAccessingSecurityScopedResource];
}

- (NSDictionary *)storedRuntimeConfig {
  NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  NSString *configPath = [[support stringByAppendingPathComponent:@"VIGO"] stringByAppendingPathComponent:@"config.json"];
  NSData *data = [NSData dataWithContentsOfFile:configPath];
  NSDictionary *config = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  return [config isKindOfClass:NSDictionary.class] ? config : @{};
}

- (BOOL)automaticCacheCleanupEnabled {
  id configured = [self storedRuntimeConfig][@"automaticCacheCleanup"];
  return configured == nil || ![configured respondsToSelector:@selector(boolValue)] || [configured boolValue];
}

- (NSSet<NSString *> *)webCacheDataTypes {
  return [NSSet setWithObjects:
    WKWebsiteDataTypeDiskCache,
    WKWebsiteDataTypeMemoryCache,
    WKWebsiteDataTypeFetchCache,
    nil];
}

- (void)clearWebCacheWithCompletion:(void (^)(void))completion {
  [[WKWebsiteDataStore defaultDataStore]
    removeDataOfTypes:[self webCacheDataTypes]
    modifiedSince:NSDate.distantPast
    completionHandler:^{
      dispatch_async(dispatch_get_main_queue(), ^{
        if (completion) completion();
      });
    }];
}

- (NSString *)configuredStoragePath {
  NSDictionary *config = [self storedRuntimeConfig];
  NSString *configured = [config[@"storageRoot"] isKindOfClass:NSString.class] ? config[@"storageRoot"] : @"";
  if (configured.length) return configured.stringByExpandingTildeInPath;
  NSString *documents = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  return [documents stringByAppendingPathComponent:@"Vigo Projects"];
}

- (void)persistStoragePath:(NSString *)storagePath {
  if (!storagePath.length) return;
  NSString *support = NSSearchPathForDirectoriesInDomains(NSApplicationSupportDirectory, NSUserDomainMask, YES).firstObject;
  NSString *configDirectory = [support stringByAppendingPathComponent:@"VIGO"];
  NSString *configPath = [configDirectory stringByAppendingPathComponent:@"config.json"];
  NSData *existingData = [NSData dataWithContentsOfFile:configPath];
  NSDictionary *existing = existingData ? [NSJSONSerialization JSONObjectWithData:existingData options:0 error:nil] : nil;
  NSMutableDictionary *config = [existing isKindOfClass:NSDictionary.class] ? [existing mutableCopy] : [NSMutableDictionary dictionary];
  NSString *timestamp = [NSISO8601DateFormatter.new stringFromDate:NSDate.date];
  config[@"schemaVersion"] = @"vigo.config.v1";
  config[@"storageRoot"] = storagePath;
  config[@"appearance"] = config[@"appearance"] ?: @"dark";
  config[@"accent"] = config[@"accent"] ?: @"blue";
  config[@"basemap"] = config[@"basemap"] ?: @"dark";
  config[@"automaticCacheCleanup"] = config[@"automaticCacheCleanup"] ?: @YES;
  config[@"configuredAt"] = config[@"configuredAt"] ?: timestamp;
  config[@"updatedAt"] = timestamp;
  NSData *data = [NSJSONSerialization dataWithJSONObject:config options:NSJSONWritingPrettyPrinted error:nil];
  [NSFileManager.defaultManager createDirectoryAtPath:configDirectory withIntermediateDirectories:YES attributes:nil error:nil];
  [data writeToFile:configPath atomically:YES];
}

- (BOOL)retainStorageAccessForURL:(NSURL *)url saveBookmark:(BOOL)saveBookmark {
  if (!url.path.length) return NO;
  if (![url startAccessingSecurityScopedResource]) {
    // Unsandboxed local builds may already have direct access; a successful
    // directory read is sufficient in that case.
    if (![NSFileManager.defaultManager isReadableFileAtPath:url.path]) return NO;
  }
  [self.authorizedStorageURL stopAccessingSecurityScopedResource];
  self.authorizedStorageURL = url;
  if (saveBookmark) {
    NSData *bookmark = [url bookmarkDataWithOptions:NSURLBookmarkCreationWithSecurityScope
                     includingResourceValuesForKeys:nil relativeToURL:nil error:nil];
    if (bookmark) [NSUserDefaults.standardUserDefaults setObject:bookmark forKey:VigoStorageBookmarkKey];
  }
  return YES;
}

- (NSURL *)restoredStorageURLForPath:(NSString *)expectedPath {
  NSData *bookmark = [NSUserDefaults.standardUserDefaults dataForKey:VigoStorageBookmarkKey];
  if (!bookmark.length) return nil;
  BOOL stale = NO;
  NSURL *url = [NSURL URLByResolvingBookmarkData:bookmark
      options:NSURLBookmarkResolutionWithSecurityScope
      relativeToURL:nil bookmarkDataIsStale:&stale error:nil];
  if (!url || ![url.path isEqualToString:expectedPath]) return nil;
  if (![self retainStorageAccessForURL:url saveBookmark:stale]) return nil;
  return url;
}

- (void)authorizeStorageAndStartServer {
  NSString *storagePath = [self configuredStoragePath];
  if ([self restoredStorageURLForPath:storagePath]) {
    [self startServer];
    return;
  }

  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.title = @"Open VIGO Workspaces";
  panel.prompt = @"Allow Access";
  panel.message = @"Choose the VIGO workspace folder once. VIGO stores a secure macOS bookmark and opens it locally on future launches.";
  panel.canChooseDirectories = YES;
  panel.canChooseFiles = NO;
  panel.canCreateDirectories = YES;
  panel.allowsMultipleSelection = NO;
  panel.resolvesAliases = YES;
  NSURL *configuredURL = [NSURL fileURLWithPath:storagePath isDirectory:YES];
  panel.directoryURL = [NSFileManager.defaultManager fileExistsAtPath:storagePath]
    ? configuredURL
    : [configuredURL URLByDeletingLastPathComponent];
  [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
    NSURL *selectedURL = result == NSModalResponseOK ? panel.URL : nil;
    if (selectedURL && [self retainStorageAccessForURL:selectedURL saveBookmark:YES]) {
      [self persistStoragePath:selectedURL.path];
      [self startServer];
      return;
    }
    [self showMessageWithTitle:@"Workspace access required" body:@"Reopen VIGO and choose the folder that contains your local workspaces. No files are uploaded."];
  }];
}

- (NSMenuItem *)menuItemWithTitle:(NSString *)title action:(SEL)action keyEquivalent:(NSString *)key modifierMask:(NSEventModifierFlags)modifierMask {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:action keyEquivalent:key ?: @""];
  item.keyEquivalentModifierMask = modifierMask;
  item.target = nil;
  return item;
}

- (void)installApplicationMenu {
  NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];

  NSMenuItem *appMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"VIGO"];
  [appMenu addItem:[self menuItemWithTitle:@"About VIGO" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@"" modifierMask:0]];
  [appMenu addItem:[NSMenuItem separatorItem]];
  [appMenu addItem:[self menuItemWithTitle:@"Hide VIGO" action:@selector(hide:) keyEquivalent:@"h" modifierMask:NSEventModifierFlagCommand]];
  [appMenu addItem:[self menuItemWithTitle:@"Hide Others" action:@selector(hideOtherApplications:) keyEquivalent:@"h" modifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagOption)]];
  [appMenu addItem:[self menuItemWithTitle:@"Show All" action:@selector(unhideAllApplications:) keyEquivalent:@"" modifierMask:0]];
  [appMenu addItem:[NSMenuItem separatorItem]];
  [appMenu addItem:[self menuItemWithTitle:@"Quit VIGO" action:@selector(terminate:) keyEquivalent:@"q" modifierMask:NSEventModifierFlagCommand]];
  appMenuItem.submenu = appMenu;
  [mainMenu addItem:appMenuItem];

  NSMenuItem *fileMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
  [fileMenu addItem:[self menuItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w" modifierMask:NSEventModifierFlagCommand]];
  fileMenuItem.submenu = fileMenu;
  [mainMenu addItem:fileMenuItem];

  NSMenuItem *editMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
  [editMenu addItem:[self menuItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z" modifierMask:NSEventModifierFlagCommand]];
  [editMenu addItem:[self menuItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z" modifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagShift)]];
  [editMenu addItem:[NSMenuItem separatorItem]];
  [editMenu addItem:[self menuItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x" modifierMask:NSEventModifierFlagCommand]];
  [editMenu addItem:[self menuItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c" modifierMask:NSEventModifierFlagCommand]];
  [editMenu addItem:[self menuItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v" modifierMask:NSEventModifierFlagCommand]];
  [editMenu addItem:[self menuItemWithTitle:@"Paste and Match Style" action:@selector(pasteAsPlainText:) keyEquivalent:@"V" modifierMask:(NSEventModifierFlagCommand | NSEventModifierFlagShift)]];
  [editMenu addItem:[NSMenuItem separatorItem]];
  [editMenu addItem:[self menuItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a" modifierMask:NSEventModifierFlagCommand]];
  editMenuItem.submenu = editMenu;
  [mainMenu addItem:editMenuItem];

  NSMenuItem *windowMenuItem = [[NSMenuItem alloc] initWithTitle:@"" action:nil keyEquivalent:@""];
  NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
  [windowMenu addItem:[self menuItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m" modifierMask:NSEventModifierFlagCommand]];
  [windowMenu addItem:[self menuItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@"" modifierMask:0]];
  windowMenuItem.submenu = windowMenu;
  [mainMenu addItem:windowMenuItem];
  NSApp.windowsMenu = windowMenu;

  NSApp.mainMenu = mainMenu;
}

- (void)createMainWindow {
  WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
  configuration.defaultWebpagePreferences.allowsContentJavaScript = YES;

  WKUserContentController *contentController = [[WKUserContentController alloc] init];
  [contentController addScriptMessageHandler:self name:@"vigoNative"];
  NSString *lockReloadScript =
    @"document.documentElement.setAttribute('data-vigo-native', 'macos');"
     "window.addEventListener('keydown', function(event) {"
      "var key = String(event.key || '').toLowerCase();"
      "if ((event.metaKey || event.ctrlKey) && key === 'r') {"
        "event.preventDefault();"
        "event.stopPropagation();"
      "}"
    "}, true);";
  WKUserScript *lockReloadUserScript = [[WKUserScript alloc]
    initWithSource:lockReloadScript
     injectionTime:WKUserScriptInjectionTimeAtDocumentStart
  forMainFrameOnly:NO];
  [contentController addUserScript:lockReloadUserScript];
  configuration.userContentController = contentController;

  self.webView = [[VigoWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
  self.webView.navigationDelegate = self;
  self.webView.UIDelegate = self;
  self.webView.allowsBackForwardNavigationGestures = YES;

  self.window = [[NSWindow alloc]
    initWithContentRect:NSMakeRect(0, 0, 1440, 900)
              styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                backing:NSBackingStoreBuffered
                  defer:NO];
  self.window.title = @"";
  self.window.titleVisibility = NSWindowTitleHidden;
  self.window.titlebarAppearsTransparent = NO;
  self.window.titlebarSeparatorStyle = NSTitlebarSeparatorStyleNone;
  self.window.minSize = NSMakeSize(1180, 760);
  self.window.tabbingMode = NSWindowTabbingModeDisallowed;
  self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
  self.window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
  self.window.backgroundColor = [NSColor colorWithSRGBRed:0.953 green:0.957 blue:0.953 alpha:1.0];
  for (NSNumber *buttonType in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)]) {
    NSButton *button = [self.window standardWindowButton:buttonType.unsignedIntegerValue];
    button.hidden = NO;
    button.enabled = YES;
  }
  self.window.contentView = self.webView;
  [self.window setFrameAutosaveName:@"VIGO Main Window"];
  [self.window center];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];

  [self showMessageWithTitle:@"Starting VIGO" body:@"Preparing the local GTFS operations runtime."];
}

- (void)startServer {
  NSString *resourcePath = NSBundle.mainBundle.resourcePath;

  if (resourcePath.length == 0) {
    [self showMessageWithTitle:@"Unable to start VIGO" body:@"The app resources folder was not found."];
    return;
  }

  NSString *nodePath = [resourcePath stringByAppendingPathComponent:@"bin/node"];
  NSString *serverPath = [resourcePath stringByAppendingPathComponent:@"server/vigo-server.mjs"];
  NSString *nativeKernelPath = [resourcePath stringByAppendingPathComponent:@"server/vigo-routing-kernel.node"];
  NSString *appPath = [resourcePath stringByAppendingPathComponent:@"app"];
  NSString *appIndexPath = [appPath stringByAppendingPathComponent:@"index.html"];

  NSFileManager *fileManager = NSFileManager.defaultManager;
  if (![fileManager isExecutableFileAtPath:nodePath]) {
    [self showMessageWithTitle:@"Unable to start VIGO" body:@"The private Node.js runtime is missing or is not executable. Reinstall VIGO from the release archive."];
    return;
  }
  if (![fileManager isReadableFileAtPath:serverPath]
      || ![fileManager isReadableFileAtPath:nativeKernelPath]
      || ![fileManager isReadableFileAtPath:appIndexPath]) {
    [self showMessageWithTitle:@"Unable to start VIGO" body:@"The bundled server, Rust routing kernel, or frontend is incomplete. Reinstall VIGO from the release archive."];
    return;
  }

  self.outputBuffer = [NSMutableString string];
  self.serverOutput = [NSPipe pipe];
  self.serverError = [NSPipe pipe];
  self.serverTask = [[NSTask alloc] init];
  self.serverTask.executableURL = [NSURL fileURLWithPath:nodePath];
  self.serverTask.arguments = @[serverPath];
  self.serverTask.currentDirectoryURL = [NSURL fileURLWithPath:resourcePath];
  self.serverTask.standardOutput = self.serverOutput;
  self.serverTask.standardError = self.serverError;

  NSMutableDictionary<NSString *, NSString *> *environment = [NSProcessInfo.processInfo.environment mutableCopy];
  [environment removeObjectsForKeys:@[
    @"DYLD_INSERT_LIBRARIES",
    @"DYLD_LIBRARY_PATH",
    @"NODE_PATH",
    @"NODE_OPTIONS",
    @"NODE_USE_SYSTEM_CA",
    @"OPENSSL_CONF",
    @"OPENSSL_MODULES",
    @"SSL_CERT_DIR",
    @"SSL_CERT_FILE",
    @"VIGO_API_PORT",
    @"VIGO_CONFIG_DIR",
    @"VIGO_DIST_DIR",
    @"VIGO_HOST",
    @"VIGO_NATIVE_ROUTING_KERNEL",
    @"VIGO_PORT",
    @"VIGO_PROJECTS_DIR"
  ]];
  environment[@"HOME"] = environment[@"HOME"] ?: NSHomeDirectory();
  environment[@"TMPDIR"] = environment[@"TMPDIR"] ?: NSTemporaryDirectory();
  environment[@"PATH"] = [NSString stringWithFormat:@"%@:/usr/bin:/bin:/usr/sbin:/sbin", [resourcePath stringByAppendingPathComponent:@"bin"]];
  environment[@"NODE_OPTIONS"] = @"--use-bundled-ca";
  environment[@"VIGO_DIST_DIR"] = appPath;
  environment[@"VIGO_NATIVE_ROUTING_KERNEL"] = nativeKernelPath;
  environment[@"VIGO_HOST"] = @"127.0.0.1";
  environment[@"VIGO_PORT"] = @"0";
  self.serverTask.environment = environment;

  __weak VigoAppDelegate *weakSelf = self;
  self.serverOutput.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
    NSData *data = handle.availableData;
    if (data.length == 0) return;

    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (text.length == 0) return;

    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf handleServerOutput:text];
    });
  };

  self.serverError.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
    NSData *data = handle.availableData;
    if (data.length == 0) return;

    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (text.length == 0) return;

    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf handleServerError:text];
    });
  };

  self.serverTask.terminationHandler = ^(NSTask *task) {
    dispatch_async(dispatch_get_main_queue(), ^{
      [weakSelf handleServerExitWithStatus:task.terminationStatus];
    });
  };

  NSError *error = nil;
  if (![self.serverTask launchAndReturnError:&error]) {
    [self showMessageWithTitle:@"Unable to start VIGO" body:error.localizedDescription ?: @"The local runtime could not be started."];
    return;
  }
}

- (void)stopServer {
  self.serverOutput.fileHandleForReading.readabilityHandler = nil;
  self.serverError.fileHandleForReading.readabilityHandler = nil;

  if (self.serverTask.isRunning) {
    [self.serverTask terminate];
  }
}

- (void)handleServerOutput:(NSString *)text {
  [self.outputBuffer appendString:text];

  while (YES) {
    NSRange newlineRange = [self.outputBuffer rangeOfString:@"\n"];
    if (newlineRange.location == NSNotFound) break;

    NSString *line = [[self.outputBuffer substringToIndex:newlineRange.location] stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    [self.outputBuffer deleteCharactersInRange:NSMakeRange(0, newlineRange.location + newlineRange.length)];
    [self handleServerLine:line];
  }
}

- (BOOL)isLoopbackRuntimeURL:(NSURL *)url {
  return url != nil &&
    [url.scheme.lowercaseString isEqualToString:@"http"] &&
    [url.host.lowercaseString isEqualToString:@"127.0.0.1"] &&
    url.port.integerValue > 0;
}

- (BOOL)isRuntimeURL:(NSURL *)url {
  if (![self isLoopbackRuntimeURL:url] || !self.runtimeOriginURL) return NO;

  return [url.scheme.lowercaseString isEqualToString:self.runtimeOriginURL.scheme.lowercaseString] &&
    [url.host.lowercaseString isEqualToString:self.runtimeOriginURL.host.lowercaseString] &&
    url.port.integerValue == self.runtimeOriginURL.port.integerValue;
}

- (BOOL)isRuntimeScriptMessage:(WKScriptMessage *)message {
  if (!self.runtimeOriginURL || !message.frameInfo.isMainFrame) return NO;

  WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
  return [origin.protocol.lowercaseString isEqualToString:self.runtimeOriginURL.scheme.lowercaseString] &&
    [origin.host.lowercaseString isEqualToString:self.runtimeOriginURL.host.lowercaseString] &&
    origin.port == self.runtimeOriginURL.port.integerValue;
}

- (void)handleServerLine:(NSString *)line {
  NSString *prefix = @"VIGO_READY ";
  if (self.didLoadServer || ![line hasPrefix:prefix]) return;

  NSString *urlString = [line substringFromIndex:prefix.length];
  NSURL *url = [NSURL URLWithString:urlString];

  if (![self isLoopbackRuntimeURL:url]) {
    [self showMessageWithTitle:@"Unable to open VIGO" body:@"The local runtime returned an invalid URL."];
    return;
  }

  self.runtimeOriginURL = url;
  self.didLoadServer = YES;
  self.navigationStartedAt = NSProcessInfo.processInfo.systemUptime;
  NSLog(@"VIGO_NAV_START %@", url.absoluteString ?: @"");
  [self.webView loadRequest:[NSURLRequest requestWithURL:url]];
  [((VigoWebView *)self.webView) lockContextMenus];
}

- (NSString *)javascriptStringLiteral:(NSString *)value {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@[value ?: @""] options:0 error:nil];
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  if (json.length < 2) return @"\"\"";
  return [json substringWithRange:NSMakeRange(1, json.length - 2)];
}

- (void)dispatchNativeCommand:(NSString *)command {
  if (!self.didLoadServer || ![self isRuntimeURL:self.webView.URL]) return;
  NSString *script = [NSString stringWithFormat:
    @"window.dispatchEvent(new CustomEvent('vigo-native-command', { detail: { command: %@ } }));",
    [self javascriptStringLiteral:command ?: @""]];
  [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (BOOL)booleanFromPayload:(NSDictionary *)payload key:(NSString *)key {
  id value = payload[key];
  return [value respondsToSelector:@selector(boolValue)] && [value boolValue];
}

- (void)applyChromeState:(NSDictionary *)payload {
  NSString *appearance = [payload[@"appearance"] isKindOfClass:NSString.class] ? payload[@"appearance"] : @"";
  if ([appearance isEqualToString:@"dark"] || [appearance isEqualToString:@"light"]) {
    NSAppearanceName appearanceName = [appearance isEqualToString:@"dark"] ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua;
    NSAppearance *nativeAppearance = [NSAppearance appearanceNamed:appearanceName];
    NSApp.appearance = nativeAppearance;
    self.window.appearance = nativeAppearance;
    self.window.backgroundColor = [appearance isEqualToString:@"dark"]
      ? [NSColor colorWithSRGBRed:0.035 green:0.047 blue:0.063 alpha:1.0]
      : [NSColor colorWithSRGBRed:0.953 green:0.957 blue:0.953 alpha:1.0];
  }

  NSString *title = [payload[@"title"] isKindOfClass:NSString.class] ? payload[@"title"] : @"";
  self.window.title = title.length ? title : @"VIGO";

}

- (void)dispatchNativeFolderPath:(NSString *)path cancelled:(BOOL)cancelled {
  NSString *script = [NSString stringWithFormat:
    @"window.dispatchEvent(new CustomEvent('vigo-native-folder', { detail: { path: %@, cancelled: %@ } }));",
    [self javascriptStringLiteral:path ?: @""],
    cancelled ? @"true" : @"false"];
  [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (void)dispatchNativeFilePath:(NSString *)path kind:(NSString *)kind cancelled:(BOOL)cancelled {
  NSString *script = [NSString stringWithFormat:
    @"window.dispatchEvent(new CustomEvent('vigo-native-file', { detail: { path: %@, kind: %@, cancelled: %@ } }));",
    [self javascriptStringLiteral:path ?: @""],
    [self javascriptStringLiteral:kind ?: @""],
    cancelled ? @"true" : @"false"];
  [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (void)dispatchNativeCacheCleaned:(NSString *)requestId {
  NSString *script = [NSString stringWithFormat:
    @"window.dispatchEvent(new CustomEvent('vigo-native-cache-cleaned', { detail: { requestId: %@, cleaned: true } }));",
    [self javascriptStringLiteral:requestId ?: @""]];
  [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (void)chooseFileWithTitle:(NSString *)title prompt:(NSString *)prompt extensions:(NSArray<NSString *> *)extensions kind:(NSString *)kind {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.title = title;
  panel.prompt = prompt;
  panel.canChooseDirectories = NO;
  panel.canChooseFiles = YES;
  panel.allowsMultipleSelection = NO;
  panel.resolvesAliases = YES;
  panel.allowedFileTypes = extensions;

  void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
    BOOL selected = result == NSModalResponseOK && panel.URL.path.length > 0;
    [self dispatchNativeFilePath:selected ? panel.URL.path : @"" kind:kind cancelled:!selected];
  };
  if (self.window) [panel beginSheetModalForWindow:self.window completionHandler:finish];
  else finish([panel runModal]);
}

- (void)chooseGtfsFile {
  [self chooseFileWithTitle:@"Choose GTFS ZIP" prompt:@"Index GTFS" extensions:@[@"zip"] kind:@"gtfs"];
}

- (void)chooseOsmFile {
  [self chooseFileWithTitle:@"Choose OpenStreetMap PBF" prompt:@"Index Streets" extensions:@[@"pbf"] kind:@"osm"];
}

- (void)chooseHomeFolder {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  panel.title = @"Choose VIGO Home Folder";
  panel.prompt = @"Use Folder";
  panel.message = @"VIGO will store workspaces, feed metadata, and local evidence in this folder.";
  panel.canChooseDirectories = YES;
  panel.canChooseFiles = NO;
  panel.canCreateDirectories = YES;
  panel.allowsMultipleSelection = NO;
  panel.resolvesAliases = YES;

  NSString *documentsPath = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject;
  if (documentsPath.length) {
    panel.directoryURL = [NSURL fileURLWithPath:documentsPath isDirectory:YES];
  }

  void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
    BOOL selected = result == NSModalResponseOK && panel.URL.path.length > 0;
    if (selected) {
      [self retainStorageAccessForURL:panel.URL saveBookmark:YES];
      [self persistStoragePath:panel.URL.path];
    }
    [self dispatchNativeFolderPath:selected ? panel.URL.path : @"" cancelled:!selected];
  };

  if (self.window) {
    [panel beginSheetModalForWindow:self.window completionHandler:finish];
  } else {
    finish([panel runModal]);
  }
}

- (void)userContentController:(WKUserContentController *)userContentController didReceiveScriptMessage:(WKScriptMessage *)message {
  if (![message.name isEqualToString:@"vigoNative"]) return;
  if (![self isRuntimeScriptMessage:message]) {
    NSLog(@"VIGO: rejected native bridge message from non-runtime frame or origin.");
    return;
  }
  if (![message.body isKindOfClass:NSDictionary.class]) return;

  NSString *action = ((NSDictionary *)message.body)[@"action"];
  if ([action isEqualToString:@"chooseHomeFolder"]) {
    [self chooseHomeFolder];
  } else if ([action isEqualToString:@"chooseGtfsFile"]) {
    [self chooseGtfsFile];
  } else if ([action isEqualToString:@"chooseOsmFile"]) {
    [self chooseOsmFile];
  } else if ([action isEqualToString:@"setChromeState"]) {
    [self applyChromeState:(NSDictionary *)message.body];
  } else if ([action isEqualToString:@"clearWebCache"]) {
    NSString *requestId = [((NSDictionary *)message.body)[@"requestId"] isKindOfClass:NSString.class]
      ? ((NSDictionary *)message.body)[@"requestId"]
      : @"";
    [self clearWebCacheWithCompletion:^{
      [self dispatchNativeCacheCleaned:requestId];
    }];
  } else if ([action isEqualToString:@"mapPhase"]) {
    NSDictionary *payload = (NSDictionary *)message.body;
    NSDictionary *timings = [payload[@"timings"] isKindOfClass:NSDictionary.class] ? payload[@"timings"] : @{};
    NSTimeInterval nativeElapsedMs = self.navigationStartedAt > 0
      ? (NSProcessInfo.processInfo.systemUptime - self.navigationStartedAt) * 1000.0
      : 0;
    NSLog(@"VIGO_MAP_PHASE phase=%@ nativeSinceNavMs=%.3f navigationToMountMs=%@ featuresMs=%@ mapLoadMs=%@ localSourceMs=%@ localFirstPaintMs=%@ basemapMs=%@ basemapAfterLocalMs=%@ basemap=%@ basemapStatus=%@ routes=%@ stops=%@ feed=%@",
      payload[@"phase"] ?: @"unknown",
      nativeElapsedMs,
      timings[@"navigationToMapMountMs"] ?: @"na",
      timings[@"featureProcessingMs"] ?: @"na",
      timings[@"mapLoadMs"] ?: @"na",
      timings[@"localSourceRenderMs"] ?: @"na",
      timings[@"localFirstPaintMs"] ?: @"na",
      timings[@"basemapReadyMs"] ?: @"na",
      timings[@"basemapAfterLocalMs"] ?: @"na",
      payload[@"basemap"] ?: @"unknown",
      payload[@"basemapStatus"] ?: @"unknown",
      payload[@"sourceRouteFeatures"] ?: @0,
      payload[@"sourceStopFeatures"] ?: @0,
      payload[@"feedName"] ?: @"");
  } else if ([action isEqualToString:@"mapReady"]) {
    NSDictionary *payload = (NSDictionary *)message.body;
    NSDictionary *timings = [payload[@"timings"] isKindOfClass:NSDictionary.class] ? payload[@"timings"] : @{};
    NSLog(@"VIGO_MAP_READY state=%@ routes=%@ stops=%@ sourceRoutes=%@ sourceStops=%@ localFirstPaintMs=%@ basemap=%@ basemapStatus=%@ feed=%@",
      payload[@"state"] ?: @"unknown",
      payload[@"routeFeatures"] ?: @0,
      payload[@"stopFeatures"] ?: @0,
      payload[@"sourceRouteFeatures"] ?: @0,
      payload[@"sourceStopFeatures"] ?: @0,
      timings[@"localFirstPaintMs"] ?: @"na",
      payload[@"basemap"] ?: @"unknown",
      payload[@"basemapStatus"] ?: @"unknown",
      payload[@"feedName"] ?: @"");
  } else if ([action isEqualToString:@"mapFailed"]) {
    NSDictionary *payload = (NSDictionary *)message.body;
    NSLog(@"VIGO_MAP_FAILED stage=%@ feed=%@ message=%@",
      payload[@"stage"] ?: @"unknown",
      payload[@"feedName"] ?: @"",
      payload[@"message"] ?: @"The local map renderer failed.");
  }
}

- (NSString *)defaultDownloadDirectory {
  NSArray<NSString *> *paths = NSSearchPathForDirectoriesInDomains(NSDownloadsDirectory, NSUserDomainMask, YES);
  NSString *downloadsPath = paths.firstObject;
  return downloadsPath.length ? downloadsPath : NSHomeDirectory();
}

- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completionHandler {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = @"VIGO";
  alert.informativeText = message ?: @"";
  alert.alertStyle = NSAlertStyleInformational;
  [alert addButtonWithTitle:@"OK"];

  void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
    completionHandler();
  };

  if (self.window) {
    [alert beginSheetModalForWindow:self.window completionHandler:finish];
  } else {
    finish([alert runModal]);
  }
}

- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL result))completionHandler {
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = message.length ? message : @"Confirm";
  alert.alertStyle = NSAlertStyleWarning;
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];

  void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
    completionHandler(result == NSAlertFirstButtonReturn);
  };

  if (self.window) {
    [alert beginSheetModalForWindow:self.window completionHandler:finish];
  } else {
    finish([alert runModal]);
  }
}

- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)defaultText initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString * _Nullable result))completionHandler {
  NSAlert *alert = [[NSAlert alloc] init];
  NSTextField *field = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 360, 26)];
  field.stringValue = defaultText ?: @"";
  alert.messageText = prompt.length ? prompt : @"Input";
  alert.alertStyle = NSAlertStyleInformational;
  alert.accessoryView = field;
  [alert addButtonWithTitle:@"OK"];
  [alert addButtonWithTitle:@"Cancel"];

  void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
    completionHandler(result == NSAlertFirstButtonReturn ? field.stringValue : nil);
  };

  if (self.window) {
    [alert beginSheetModalForWindow:self.window completionHandler:finish];
  } else {
    finish([alert runModal]);
  }
}

- (void)webView:(WKWebView *)webView runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSArray<NSURL *> *URLs))completionHandler {
  NSOpenPanel *panel = [NSOpenPanel openPanel];
  BOOL allowsDirectories = parameters.allowsDirectories;

  panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
  panel.canChooseDirectories = allowsDirectories;
  panel.canChooseFiles = !allowsDirectories;
  panel.canCreateDirectories = NO;
  panel.resolvesAliases = YES;
  panel.prompt = allowsDirectories ? @"Upload Folder" : @"Upload";

  void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
    completionHandler(result == NSModalResponseOK ? panel.URLs : @[]);
  };

  if (self.window) {
    [panel beginSheetModalForWindow:self.window completionHandler:finish];
  } else {
    finish([panel runModal]);
  }
}

- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
  if (@available(macOS 11.3, *)) {
    if (navigationAction.shouldPerformDownload) {
      decisionHandler(WKNavigationActionPolicyDownload);
      return;
    }
  }

  NSURL *url = navigationAction.request.URL;
  BOOL isTopLevelNavigation = navigationAction.targetFrame == nil || navigationAction.targetFrame.isMainFrame;
  if (!isTopLevelNavigation) {
    decisionHandler(WKNavigationActionPolicyAllow);
    return;
  }

  if ([url.scheme.lowercaseString isEqualToString:@"about"] && [url.absoluteString isEqualToString:@"about:blank"]) {
    decisionHandler(WKNavigationActionPolicyAllow);
    return;
  }

  if ([self isRuntimeURL:url]) {
    if (navigationAction.targetFrame == nil) {
      [webView loadRequest:navigationAction.request];
      decisionHandler(WKNavigationActionPolicyCancel);
    } else {
      decisionHandler(WKNavigationActionPolicyAllow);
    }
    return;
  }

  NSString *scheme = url.scheme.lowercaseString;
  if ([scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"]) {
    [NSWorkspace.sharedWorkspace openURL:url];
  }
  decisionHandler(WKNavigationActionPolicyCancel);
}

- (void)showNavigationFailure:(NSError *)error {
  if (error.code == NSURLErrorCancelled) return;
  NSString *detail = error.localizedDescription.length ? error.localizedDescription : @"The local interface could not be loaded.";
  NSLog(@"VIGO navigation failed: %@", detail);
  [self showMessageWithTitle:@"Unable to open VIGO" body:detail];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
  if ([webView.URL.host isEqualToString:@"127.0.0.1"]) {
    NSTimeInterval elapsedMs = self.navigationStartedAt > 0
      ? (NSProcessInfo.processInfo.systemUptime - self.navigationStartedAt) * 1000.0
      : 0;
    NSLog(@"VIGO_NAV_READY elapsedMs=%.3f %@", elapsedMs, webView.URL.absoluteString ?: @"");
  }
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  [self showNavigationFailure:error];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
  [self showNavigationFailure:error];
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
  NSLog(@"VIGO web process terminated; reloading the local interface.");
  [webView reload];
}

- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)navigationAction didBecomeDownload:(WKDownload *)download {
  download.delegate = self;
}

- (void)webView:(WKWebView *)webView navigationResponse:(WKNavigationResponse *)navigationResponse didBecomeDownload:(WKDownload *)download {
  download.delegate = self;
}

- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response suggestedFilename:(NSString *)suggestedFilename completionHandler:(void (^)(NSURL *destination))completionHandler {
  NSSavePanel *panel = [NSSavePanel savePanel];
  NSString *filename = suggestedFilename.length ? suggestedFilename : response.suggestedFilename;

  panel.nameFieldStringValue = filename.length ? filename : @"VIGO Download";
  panel.canCreateDirectories = YES;
  panel.directoryURL = [NSURL fileURLWithPath:[self defaultDownloadDirectory] isDirectory:YES];

  void (^finish)(NSModalResponse) = ^(NSModalResponse result) {
    completionHandler(result == NSModalResponseOK ? panel.URL : nil);
  };

  if (self.window) {
    [panel beginSheetModalForWindow:self.window completionHandler:finish];
  } else {
    finish([panel runModal]);
  }
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
  if (error.code == NSURLErrorCancelled) return;
  NSLog(@"VIGO: download failed: %@", error.localizedDescription);
}

- (void)handleServerError:(NSString *)text {
  NSString *trimmed = [text stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  if (trimmed.length == 0) return;
  NSLog(@"VIGO server: %@", trimmed);
}

- (void)handleServerExitWithStatus:(int)status {
  NSLog(@"VIGO: server exited with status %d", status);

  if (!self.didLoadServer) {
    [self showMessageWithTitle:@"VIGO stopped before opening"
                          body:[NSString stringWithFormat:@"The local runtime exited with status %d. Launch VIGO from Terminal to inspect server logs.", status]];
  }
}

- (void)showMessageWithTitle:(NSString *)title body:(NSString *)body {
  NSString *html = [NSString stringWithFormat:
    @"<!doctype html><html><head><meta charset=\"utf-8\"><style>"
     "html,body{height:100%%;margin:0;background:#05070a;color:#f8fafc;font:15px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}"
     "body{align-items:center;display:flex;justify-content:center;}"
     "main{max-width:430px;padding:34px;text-align:center;}"
     "h1{font-size:24px;font-weight:700;letter-spacing:.08em;margin:0 0 10px;}"
     "p{color:#cbd5e1;line-height:1.5;margin:0;}"
     "</style></head><body><main><h1>%@</h1><p>%@</p></main></body></html>",
    [self escapeHtml:title],
    [self escapeHtml:body]];

  [self.webView loadHTMLString:html baseURL:nil];
}

- (NSString *)escapeHtml:(NSString *)value {
  NSString *escaped = [value stringByReplacingOccurrencesOfString:@"&" withString:@"&amp;"];
  escaped = [escaped stringByReplacingOccurrencesOfString:@"<" withString:@"&lt;"];
  escaped = [escaped stringByReplacingOccurrencesOfString:@">" withString:@"&gt;"];
  escaped = [escaped stringByReplacingOccurrencesOfString:@"\"" withString:@"&quot;"];
  escaped = [escaped stringByReplacingOccurrencesOfString:@"'" withString:@"&#39;"];
  return escaped;
}

@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *application = [NSApplication sharedApplication];
    VigoAppDelegate *delegate = [[VigoAppDelegate alloc] init];
    application.delegate = delegate;
    [application run];
  }

  return 0;
}
