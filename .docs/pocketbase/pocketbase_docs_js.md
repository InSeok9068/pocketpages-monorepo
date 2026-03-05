# POCKETBASE DOCS|2025-10-15|39 sections

## 1.Introduction
Introduction  Please keep in mind that PocketBase is still under active development and full backward
compatibility is not guaranteed before reaching v1.0.0. PocketBase is NOT recommended for
production critical applications yet, unless you are fine with reading the
and applying some manual migration steps from time to time.
PocketBase is an open source backend consisting of embedded database (SQLite) with realtime subscriptions,
builtin auth management, convenient dashboard UI and simple REST-ish API. It can be used both as Go
framework and as standalone application.
See the
for other platforms and more details.
Once you&#39;ve extracted the archive, you could start the application by running
./pocketbase serve in the extracted directory.
And that&#39;s it!
The first time it will generate an installer link that should be automatically opened in the browser to set
up your first superuser account
(you can also create the first superuser manually via
./pocketbase superuser create EMAIL PASS)
The started web server has the following default routes:
-http://127.0.0.1:8090
- if pb_public directory exists, serves the static content from it (html, css, images,
etc.)
-http://127.0.0.1:8090/_/
- superusers dashboard
-http://127.0.0.1:8090/api/
- REST-ish API
The prebuilt PocketBase executable will create and manage 2 new directories alongside the executable:
-pb_data - stores your application data, uploaded files, etc. (usually should be added in
.gitignore).
-pb_migrations - contains JS migration files with your collection changes (can be safely
committed in your repository).
You can even write custom migration scripts. For more info check the
JS migrations docs.
You could find all available commands and their options by running
./pocketbase --help or
./pocketbase [command] --help

## 2.How to use PocketBase
How to use PocketBase The easiest way to use PocketBase is by interacting with its Web APIs directly from the client-side (e.g.
mobile app or browser SPA).
It was designed with this exact use case in mind and it is also the reason why there are general purpose
JSON APIs for listing, pagination, sorting, filtering, etc.
The access and filter controls for your data are usually done through the
collection API rules
For the cases when you need more specialized handling (sending emails, intercepting the default actions,
creating new routes, etc.) you can
extend PocketBase with Go or JavaScript
For interacting with the
Web APIs
you can make use of the official SDK clients:
-JavaScript SDK (Browser, Node.js, React Native)
-Dart SDK (Web, Mobile, Desktop, CLI)
When used on the client-side, it is safe to have a single/global SDK instance for the entire lifecycle of
your application.
Web apps recommendation    Not everyone will agree with this, but if you are building a web app with PocketBase I recommend
developing the frontend as a traditional client-side SPA and for the cases where additional
server-side handling is needed (e.g. for payment webhooks, extra data server validations, etc.) you
could try to:
-Use PocketBase as Go/JS framework to create new routes or
intercept existing.
-Create one-off Node.js/Bun/Deno/etc. server-side actions that will interact with
PocketBase only as superuser and as pure data store (similar to traditional database
interactions but over HTTP). In this case it is safe to have a global superuser client
such as:
// src/superuser.js
import PocketBase from "pocketbase"
// disable autocancellation so that we can handle async requests from multiple users
superuserClient.autoCancellation(false);
// option 1: authenticate as superuser using email/password (could be filled with ENV params)
await superuserClient.collection('_superusers').authWithPassword(SUPERUSER_EMAIL, SUPERUSER_PASS, {
// This will trigger auto refresh or auto reauthentication in case
autoRefreshThreshold: 30 * 60
// option 2: OR authenticate as superuser via long-lived "API key"
// (see https://pocketbase.io/docs/authentication/#api-keys)
superuserClient.authStore.save('YOUR_GENERATED_SUPERUSER_TOKEN')
export default superuserClient;  Then you can directly import the file in your server-side actions and use the client as
usual:
import superuserClient from './src/superuser.js'
async function serverAction(req, resp) {
... do some extra data validations or handling ...
// send a create request as superuser
await superuserClient.collection('example').create({ ... })
in a JS SSR mode
is possible but it comes with many complications and you need to carefully evaluate whether the cost
of having another backend (PocketBase) alongside your existing one (the Node.js server) is worth it.
JS SSR - issues and recommendations #5313 but some of the common pitfalls are:
-Security issues caused by incorrectly initialized and shared JS SDK instance in a long-running
server-side context.
-OAuth2 integration difficulties related to the server-side only OAuth2 flow (or its mixed
&quot;all-in-one&quot; client-side handling and sharing a cookie with the server-side).
-Proxying realtime connections and essentially duplicating the same thing PocketBase already
does.
-Performance bottlenecks caused by the default single-threaded Node.js process and the
excessive resources utilization due to the server-side rendering and heavy back-and-forth
requests communication between the different layers (client&lt;->Node.js&lt;->PocketBase).
This doesn&#39;t mean that using PocketBase with JS SSR is always a &quot;bad thing&quot; but based on the
dozens reported issues so far I would recommend it only after careful evaluation and only to more
experienced developers that have in-depth understanding of the used tools and their trade-offs. If
you still want to use PocketBase to handle regular users authentication with a JS SSR meta
framework, then you can find some JS SDK examples in the repo&#39;s
JS SSR integration section
Why not htmx, Hotwire/Turbo, Unpoly, etc.    htmx, Hotwire/Turbo, Unpoly and other similar tools are commonly used for building server rendered
applications but unfortunately they don&#39;t play well with the JSON APIs and fully stateless nature
of PocketBase.
It is possible to use them with PocketBase but at the moment I don&#39;t recommend it because we lack
the necessary helpers and utilities for building SSR-first applications, which means that you
might have to create from scratch a lot of things on your own such as middlewares for handling
cookies (and eventually also taking care of CORS and CSRF) or custom authentication
endpoints and access controls (the collection API rules apply only for the builtin JSON routes).
In the future we could eventually provide official SSR support in terms of guides and middlewares
for this use case but again - PocketBase wasn&#39;t designed with this in mind and you may want to
reevaluate the tech stack of your application and switch to a traditional client-side SPA as
mentioned earlier or use a different backend solution that might fit better with your use case.
Mobile apps auth persistence    When building mobile apps with the JavaScript SDK or Dart SDK you&#39;ll have to specify a custom
persistence store if you want to preserve the authentication between the various app activities
and open/close state.
The SDKs come with a helper async storage implementation that allows you to hook any custom
persistent layer (local file, SharedPreferences, key-value based database, etc.). Here is a
minimal PocketBase SDKs initialization for React Native (JavaScript) and Flutter (Dart):
Dart  // Node.js and React Native doesn't have native EventSource implementation
// so in order to use the realtime subscriptions you'll need to load EventSource polyfill,
// for example: npm install react-native-sse --save
import eventsource from 'react-native-sse';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PocketBase, { AsyncAuthStore } from 'pocketbase';
// load the polyfill
global.EventSource = eventsource;
// initialize the async store
const store = new AsyncAuthStore({
save:    async (serialized) => AsyncStorage.setItem('pb_auth', serialized),
initial: AsyncStorage.getItem('pb_auth'),
// initialize the PocketBase client
// (it is OK to have a single/global instance for the duration of your application)
const pb = new PocketBase('http://127.0.0.1:8090', store);
console.log(pb.authStore.record)  import 'package:pocketbase/pocketbase.dart';
import 'package:shared_preferences/shared_preferences.dart';
// for simplicity we are using a simple SharedPreferences instance
// but you can also replace it with its safer EncryptedSharedPreferences alternative
final prefs = await SharedPreferences.getInstance();
// initialize the async store
final store = AsyncAuthStore(
save:    (String data) async => prefs.setString('pb_auth', data),
initial: prefs.getString('pb_auth'),
// initialize the PocketBase client
// (it is OK to have a single/global instance for the duration of your application)
final pb = PocketBase('http://127.0.0.1:8090', authStore: store);
print(pb.authStore.record);      React Native file upload on Android and iOS    At the time of writing, React Native on Android and iOS seems to have a non-standard
FormData implementation and for uploading files on these platforms it requires the following
special object syntax:
uri: "...",
type: "...",
name: "..."
}  Or in other words, you may have to apply a conditional handling similar to:
const data = new FormData();
// result is the resolved promise of ImagePicker.launchImageLibraryAsync
let imageUri = result.assets[0].uri;
if (Platform.OS === 'web') {
const req = await fetch(imageUri);
const blob = await req.blob();
data.append('avatar', blob); // regular File/Blob value
} else {
// the below object format works only on Android and iOS
// (FormData.set() also doesn't seem to be supported so we use FormData.append())
data.append('avatar', {
uri:  imageUri,
type: 'image/*',
name: imageUri.split('/').pop(),
collections, records, authentication, relations, files handling, etc.

## 3.pb-ext - Enhanced PocketBase Server
# pb-ext
Enhanced PocketBase server with monitoring, logging & API docs.
<img width="3840" height="2160" alt="pb-ext" src="https://github.com/user-attachments/assets/af360704-c3d6-4d1f-9b49-80229d6570d2" />
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/magooney-loon/pb-ext)
## Core Features
- **API Schema**: Auto-generates OpenAPI docs UI for your endpoints
- **Cron Tracking**: Logs and monitors scheduled cron jobs
- **System Monitoring**: Real-time CPU, memory, disk, network, and runtime metrics
- **Structured Logging**: Complete logging with error tracking and request tracing
- **Visitor Analytics**: Track visitor stats, page views, device types, and browsers
- **PocketBase Integration**: Uses PocketBase's auth system and styling
## Access
- Admin panel:
```bash
127.0.0.1:8090/_
```
- pb-ext dashboard:
```bash
127.0.0.1:8090/_/_
```
## Quick Start
> 🆕 New to Golang and/or PocketBase? [Read this beginner tutorial](TUTORIAL.md).
```go
package main
import (
"flag"
"log"
app "github.com/magooney-loon/pb-ext/core"
"github.com/pocketbase/pocketbase/core"
func main() {
devMode := flag.Bool("dev", false, "Run in developer mode")
flag.Parse()
initApp(*devMode)
func initApp(devMode bool) {
var opts []app.Option
if devMode {
opts = append(opts, app.InDeveloperMode())
} else {
opts = append(opts, app.InNormalMode())
srv := app.New(opts...)
app.SetupLogging(srv)
registerCollections(srv.App())
registerRoutes(srv.App())
registerJobs(srv.App())
srv.App().OnServe().BindFunc(func(e *core.ServeEvent) error {
app.SetupRecovery(srv.App(), e)
if err := srv.Start(); err != nil {
srv.App().Logger().Error("Fatal application error",
"error", err,
"uptime", srv.Stats().StartTime,
"total_requests", srv.Stats().TotalRequests.Load(),
"active_connections", srv.Stats().ActiveConnections.Load(),
"last_request_time", srv.Stats().LastRequestTime.Load(),
log.Fatal(err)
// Example models in cmd/server/collections.go
// Example routes in cmd/server/routes.go
// Example handlers in cmd/server/handlers.go
// Example cron jobs in cmd/server/jobs.go
// You can restructure Your project as You wish,
// just keep this main.go in cmd/server/main.go
// Consider using the cmd/scripts commands for
// streamlined fullstack dx with +Svelte5kit+
// Ready for a production build deployment?
// https://github.com/magooney-loon/pb-deployer
```
```bash
go mod tidy
go run cmd/scripts/main.go --run-only
```
See `**/*/README.md` for detailed docs.
Having issues with Your API Docs?
```bash
127.0.0.1:8090/api/docs/debug/ast
```

## 4.pb-ext - Scripts Documentation
## [COMMAND SEQUENCES]
### > Standard Development Mode
```
$ go run cmd/scripts/main.go
```
*Builds frontend + starts development server*
### > Full System Installation
```
$ go run cmd/scripts/main.go --install
```
### > Frontend Compilation Only
```
$ go run cmd/scripts/main.go --build-only
```
*Compiles frontend assets without server daemon*
### > Development Server Only
```
$ go run cmd/scripts/main.go --run-only
```
*Starts server daemon, skips build sequence*
### > Production Deployment Build
```
$ go run cmd/scripts/main.go --production
```
*Creates optimized production binary + assets*
### > Test Suite Execution
```
$ go run cmd/scripts/main.go --test-only
```
*Runs comprehensive test suite with coverage reports*
### > Custom Output Directory
```
$ go run cmd/scripts/main.go --production --dist release
```
*Production build with custom target directory*
### > System Help Terminal
```
$ go run cmd/scripts/main.go --help
```
*Displays all available command flags and options*
## [DEPLOYMENT INTEGRATION]
### Automated VPS Deployment via pb-deployer:
```
$ git clone https://github.com/magooney-loon/pb-deployer
$ cd pb-deployer && go run cmd/scripts/main.go --install
```
### pb-deployer Features:
[✓] Automated server provisioning + security hardening
[✓] Zero-downtime deployment cycles with rollback
[✓] Production systemd service management
[✓] Full PocketBase v0.20+ compatibility
## [SYSTEM REQUIREMENTS]
[REQUIRED]
├── Go 1.19+        (backend compilation)
├── Node.js 16+     (frontend build system)
├── npm 8+          (dependency management)
└── Git             (version control)
[OPTIONAL]
└── pb-deployer     (production deployment automation)
## [BUILD PROCESS]
[DEVELOPMENT MODE]
1. System validation    → Check Go/Node/npm availability
2. Dependency install   → npm install + go mod tidy
3. Frontend build       → npm run build
4. Asset deployment     → Copy to pb_public/
5. Server startup       → go run ./cmd/server --dev serve
[PRODUCTION MODE]
1. Environment prep     → Clean dist/ directory
2. Dependency install   → Full dependency resolution
3. Frontend build       → Optimized production build
4. Server compilation   → go build -ldflags="-s -w"
5. Asset packaging      → Create deployment archive
6. Metadata generation  → Build info + package metadata
[TEST MODE]
1. System validation    → Verify test environment
2. Test execution       → Run all test suites
3. Coverage analysis    → Generate coverage reports
4. Report generation    → HTML/JSON/TXT outputs
## [TROUBLESHOOTING]
[ERROR: Command not found]
→ Ensure Go/Node/npm are installed and in system PATH
[ERROR: Frontend build failed]
→ Check package.json and run 'npm install' manually
→ Verify frontend/ directory exists with valid source
[ERROR: Server compilation failed]
→ Run 'go mod tidy' to resolve dependencies
→ Check cmd/server/main.go exists
[ERROR: Permission denied]
→ Ensure write permissions for pb_public/ and dist/

## 5.pb-ext - Collections Implementation
```go
package main
// Collection example
import (
"github.com/pocketbase/pocketbase/core"
// registerCollections sets up all database collections for the application
func registerCollections(app core.App) {
app.OnServe().BindFunc(func(e *core.ServeEvent) error {
if existingCollection != nil {
return nil
// Find users collection for optional relation (v2 auth)
usersCollection, err := app.FindCollectionByNameOrId("users")
if err != nil {
return err
// Add optional user relation
collection.Fields.Add(&core.RelationField{
Name:          "user",
Required:      false, // Optional - v1 routes won't use this
CollectionId:  usersCollection.Id,
CascadeDelete: true,
// Add title field (required)
collection.Fields.Add(&core.TextField{
Name:     "title",
Required: true,
Max:      200,
// Add description field (optional)
collection.Fields.Add(&core.TextField{
Name:     "description",
Required: false,
Max:      1000,
// Add completed field (boolean, default false)
collection.Fields.Add(&core.BoolField{
Name: "completed",
// Add priority field (select)
collection.Fields.Add(&core.SelectField{
Name:   "priority",
Values: []string{"low", "medium", "high"},
// Add auto-date fields
collection.Fields.Add(&core.AutodateField{
Name:     "created",
OnCreate: true,
collection.Fields.Add(&core.AutodateField{
Name:     "updated",
OnCreate: true,
OnUpdate: true,
// Set collection rules - public access for v1
collection.ViewRule = nil   // Public read
collection.CreateRule = nil // Public create
collection.UpdateRule = nil // Public update
collection.DeleteRule = nil // Public delete
// Add indexes
// Save the collection
if err := app.Save(collection); err != nil {
return err
return nil
```

## 6.pb-ext - Handlers Implementation
```go
package main
// API_SOURCE
import (
"encoding/json"
"net/http"
"strconv"
"time"
"github.com/pocketbase/pocketbase/core"
// Request types
Title       string `json:"title"`
Description string `json:"description,omitempty"`
Priority    string `json:"priority,omitempty"` // low, medium, high
Completed   bool   `json:"completed"`
Title       *string `json:"title,omitempty"`
Description *string `json:"description,omitempty"`
Priority    *string `json:"priority,omitempty"`
Completed   *bool   `json:"completed,omitempty"`
// API_DESC Get current server time in multiple formats
// API_TAGS public,utility,time
func timeHandler(c *core.RequestEvent) error {
now := time.Now()
return c.JSON(http.StatusOK, map[string]any{
"time": map[string]string{
"iso":       now.Format(time.RFC3339),
"unix":      strconv.FormatInt(now.Unix(), 10),
"unix_nano": strconv.FormatInt(now.UnixNano(), 10),
"utc":       now.UTC().Format(time.RFC3339),
"server":  "pb-ext",
"version": "1.0.0",
// Check authentication - required for creation
if c.Auth == nil {
return c.JSON(http.StatusUnauthorized, map[string]any{"error": "Authentication required"})
if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
return c.JSON(http.StatusBadRequest, map[string]any{"error": "Invalid JSON payload"})
if req.Title == "" {
return c.JSON(http.StatusBadRequest, map[string]any{"error": "Title is required"})
// Validate priority if provided
if req.Priority != "" && req.Priority != "low" && req.Priority != "medium" && req.Priority != "high" {
return c.JSON(http.StatusBadRequest, map[string]any{"error": "Priority must be 'low', 'medium', or 'high'"})
// Default priority to medium if not provided
if req.Priority == "" {
req.Priority = "medium"
"title":       req.Title,
"description": req.Description,
"priority":    req.Priority,
"completed":   req.Completed,
// Only set user field if authenticated user is from users collection
// Superusers/admins don't have records in users collection
if c.Auth.Collection().Name == "users" {
// If authenticated as superuser, leave user field empty or handle differently
if err != nil {
return c.JSON(http.StatusInternalServerError, map[string]any{"error": "Collection not found"})
record := core.NewRecord(collection)
if err := c.App.Save(record); err != nil {
return c.JSON(http.StatusCreated, map[string]any{
"id":          record.Id,
"title":       record.GetString("title"),
"description": record.GetString("description"),
"priority":    record.GetString("priority"),
"completed":   record.GetBool("completed"),
"created_at":  record.GetDateTime("created"),
"user_id":     record.GetString("user"),
"created_by":  c.Auth.Collection().Name, // Show if created by user or admin
if err != nil {
return c.JSON(http.StatusInternalServerError, map[string]any{"error": "Collection not found"})
// Build query with optional filters
filter := ""
filterParams := make(map[string]any)
// Filter by completion status if provided
if completed := c.Request.URL.Query().Get("completed"); completed != "" {
if completed == "true" || completed == "1" {
filter = "completed = true"
} else if completed == "false" || completed == "0" {
filter = "completed = false"
// Filter by priority if provided
if priority := c.Request.URL.Query().Get("priority"); priority != "" {
if filter != "" {
filter += " && "
filter += "priority = {:priority}"
filterParams["priority"] = priority
// For authenticated requests, filter by user (only if user is from users collection)
if c.Auth != nil && c.Auth.Collection().Name == "users" {
if filter != "" {
filter += " && "
filter += "user = {:userId}"
filterParams["userId"] = c.Auth.Id
records, err := c.App.FindRecordsByFilter(collection, filter, "-created", 100, 0, filterParams)
if err != nil {
for i, record := range records {
"id":          record.Id,
"title":       record.GetString("title"),
"description": record.GetString("description"),
"priority":    record.GetString("priority"),
"completed":   record.GetBool("completed"),
"created_at":  record.GetDateTime("created"),
"updated_at":  record.GetDateTime("updated"),
// Include user info if available
if userId := record.GetString("user"); userId != "" {
return c.JSON(http.StatusOK, map[string]any{
"filters": map[string]any{
"completed": c.Request.URL.Query().Get("completed"),
"priority":  c.Request.URL.Query().Get("priority"),
if err != nil {
return c.JSON(http.StatusInternalServerError, map[string]any{"error": "Collection not found"})
if err != nil {
// For authenticated requests, check ownership (only enforce for regular users)
if c.Auth != nil && c.Auth.Collection().Name == "users" {
if userID := record.GetString("user"); userID != "" && userID != c.Auth.Id {
return c.JSON(http.StatusForbidden, map[string]any{"error": "Access denied"})
return c.JSON(http.StatusOK, map[string]any{
"id":          record.Id,
"title":       record.GetString("title"),
"description": record.GetString("description"),
"priority":    record.GetString("priority"),
"completed":   record.GetBool("completed"),
"created_at":  record.GetDateTime("created"),
"updated_at":  record.GetDateTime("updated"),
"user_id":     record.GetString("user"),
// Check authentication - required for updates
if c.Auth == nil {
return c.JSON(http.StatusUnauthorized, map[string]any{"error": "Authentication required"})
if err != nil {
return c.JSON(http.StatusInternalServerError, map[string]any{"error": "Collection not found"})
if err != nil {
if c.Auth.Collection().Name == "users" {
if userID := record.GetString("user"); userID != c.Auth.Id {
if err := json.NewDecoder(c.Request.Body).Decode(&req); err != nil {
return c.JSON(http.StatusBadRequest, map[string]any{"error": "Invalid JSON payload"})
// Apply updates
updates := make(map[string]any)
if req.Title != nil {
if *req.Title == "" {
return c.JSON(http.StatusBadRequest, map[string]any{"error": "Title cannot be empty"})
record.Set("title", *req.Title)
updates["title"] = *req.Title
if req.Description != nil {
record.Set("description", *req.Description)
updates["description"] = *req.Description
if req.Priority != nil {
if *req.Priority != "low" && *req.Priority != "medium" && *req.Priority != "high" {
return c.JSON(http.StatusBadRequest, map[string]any{"error": "Priority must be 'low', 'medium', or 'high'"})
record.Set("priority", *req.Priority)
updates["priority"] = *req.Priority
if req.Completed != nil {
record.Set("completed", *req.Completed)
updates["completed"] = *req.Completed
if err := c.App.Save(record); err != nil {
return c.JSON(http.StatusOK, map[string]any{
"id":          record.Id,
"title":       record.GetString("title"),
"description": record.GetString("description"),
"priority":    record.GetString("priority"),
"completed":   record.GetBool("completed"),
"updated_at":  record.GetDateTime("updated"),
"updates": updates,
// Check authentication - required for deletion
if c.Auth == nil {
return c.JSON(http.StatusUnauthorized, map[string]any{"error": "Authentication required"})
if err != nil {
return c.JSON(http.StatusInternalServerError, map[string]any{"error": "Collection not found"})
if err != nil {
if c.Auth.Collection().Name == "users" {
if userID := record.GetString("user"); userID != c.Auth.Id {
if err := c.App.Delete(record); err != nil {
return c.JSON(http.StatusOK, map[string]any{
"title": record.GetString("title"),
"deleted_at": time.Now().Format(time.RFC3339),
```

## 7.pb-ext - Jobs Implementation
```go
package main
import (
"fmt"
"time"
"github.com/magooney-loon/pb-ext/core/server"
"github.com/pocketbase/pocketbase/core"
func registerJobs(app core.App) {
app.OnServe().BindFunc(func(e *core.ServeEvent) error {
// Register example cron jobs
if err := helloJob(app); err != nil {
app.Logger().Error("Failed to register hello job", "error", err)
return err
if err := dailyCleanupJob(app); err != nil {
app.Logger().Error("Failed to register daily cleanup job", "error", err)
return err
if err := weeklyStatsJob(app); err != nil {
app.Logger().Error("Failed to register weekly stats job", "error", err)
return err
app.Logger().Info("All cron jobs registered successfully")
func helloJob(app core.App) error {
jobManager := server.GetJobManager()
if jobManager == nil {
return fmt.Errorf("job manager not initialized")
return jobManager.RegisterJob("helloWorld", "Hello World Job",
"A simple demonstration job that runs every 5 minutes, outputs timestamped hello messages and simulates basic task processing",
"*/5 * * * *", func(jobLogger *server.JobExecutionLogger) {
jobLogger.Start("Hello World Job")
jobLogger.Info("Current time: %s", time.Now().Format("2006-01-02 15:04:05"))
jobLogger.Progress("Processing hello world task...")
// Simulate some work
time.Sleep(100 * time.Millisecond)
jobLogger.Success("Hello from cron job! Task completed successfully.")
jobLogger.Complete(fmt.Sprintf("Job finished at: %s", time.Now().Format("2006-01-02 15:04:05")))
func dailyCleanupJob(app core.App) error {
jobManager := server.GetJobManager()
if jobManager == nil {
return fmt.Errorf("job manager not initialized")
return jobManager.RegisterJob("dailyCleanup", "Daily Cleanup Job",
"0 2 * * *", func(jobLogger *server.JobExecutionLogger) {
jobLogger.Start("Daily Cleanup Job")
jobLogger.Info("Cleanup job started at: %s", time.Now().Format("2006-01-02 15:04:05"))
app.Logger().Info("Running daily cleanup job", "time", time.Now())
if err != nil {
jobLogger.Fail(err)
return
cutoffDate := time.Now().AddDate(0, 0, -30)
filter := "completed = true && created < {:cutoff}"
records, err := app.FindRecordsByFilter(collection, filter, "", 100, 0, map[string]any{
"cutoff": cutoffDate.Format("2006-01-02 15:04:05.000Z"),
if err != nil {
jobLogger.Fail(err)
return
deletedCount := 0
for _, record := range records {
if err := app.Delete(record); err != nil {
} else {
deletedCount++
jobLogger.Statistics(map[string]interface{}{
"total_found": len(records),
"deleted":     deletedCount,
"failed":      len(records) - deletedCount,
jobLogger.Complete(fmt.Sprintf("Deleted %d/%d records", deletedCount, len(records)))
app.Logger().Info("Daily cleanup completed", "deleted_records", deletedCount)
func weeklyStatsJob(app core.App) error {
jobManager := server.GetJobManager()
if jobManager == nil {
return fmt.Errorf("job manager not initialized")
return jobManager.RegisterJob("weeklyStats", "Weekly Statistics Job",
"0 0 * * 0", func(jobLogger *server.JobExecutionLogger) {
jobLogger.Start("Weekly Statistics Job")
jobLogger.Info("Generating weekly report for week ending: %s", time.Now().Format("2006-01-02"))
app.Logger().Info("Generating weekly statistics", "time", time.Now())
if err != nil {
jobLogger.Fail(err)
return
weekAgo := time.Now().AddDate(0, 0, -7)
filter := "created >= {:week_ago}"
records, err := app.FindRecordsByFilter(collection, filter, "", 1000, 0, map[string]any{
"week_ago": weekAgo.Format("2006-01-02 15:04:05.000Z"),
if err != nil {
jobLogger.Fail(err)
return
completed := 0
pending := 0
for _, record := range records {
if record.GetBool("completed") {
completed++
} else {
pending++
completionRate := float64(0)
if len(records) > 0 {
completionRate = float64(completed) / float64(len(records)) * 100
// Log statistics using the structured method
stats := map[string]interface{}{
"Completion rate":     fmt.Sprintf("%.1f%%", completionRate),
jobLogger.Info("WEEKLY STATISTICS REPORT")
jobLogger.Statistics(stats)
jobLogger.Complete("Weekly statistics report generated successfully")
app.Logger().Info("Weekly statistics generated",
"completion_rate", completionRate,
```

## 8.pb-ext - Routes Implementation
```go
package main
// API_SOURCE
import (
"github.com/magooney-loon/pb-ext/core/server/api"
"github.com/pocketbase/pocketbase/apis"
"github.com/pocketbase/pocketbase/core"
func registerRoutes(app core.App) {
// Initialize version manager with configs
versionManager := api.InitializeVersionedSystem(createAPIVersions(), "v1")
app.OnServe().BindFunc(func(e *core.ServeEvent) error {
// Get version-specific routers
v1Router, err := versionManager.GetVersionRouter("v1", e)
if err != nil {
return err
v2Router, err := versionManager.GetVersionRouter("v2", e)
if err != nil {
return err
// Register v1 routes
registerV1Routes(v1Router)
// Register v2 routes
registerV2Routes(v2Router)
// Register version management endpoints
versionManager.RegisterWithServer(app)
// createAPIVersions creates version configurations with reduced duplication
func createAPIVersions() map[string]*api.APIDocsConfig {
baseConfig := &api.APIDocsConfig{
Title:       "pb-ext demo api",
Description: "Hello world",
BaseURL:     "http://127.0.0.1:8090/",
Enabled:     true,
// Create v1 config
v1Config := *baseConfig
v1Config.Version = "1.0.0"
v1Config.Status = "stable"
// Create v2 config
v2Config := *baseConfig
v2Config.Version = "2.0.0"
v2Config.Status = "testing"
return map[string]*api.APIDocsConfig{
"v1": &v1Config,
"v2": &v2Config,
// registerV1Routes registers all v1 API routes
func registerV1Routes(router *api.VersionedAPIRouter) {
// Option 1: Manual route registration (explicit control)
prefix := "/api/v1"
// Option 2: CRUD convenience method (less boilerplate)
// Uncomment to use instead of manual registration above:
// v1 := router.SetPrefix("/api/v1")
// }, apis.RequireAuth()) // Auth applied to Create, Update, Patch, Delete
// registerV2Routes registers all v2 API routes
func registerV2Routes(router *api.VersionedAPIRouter) {
// Using prefixed router for cleaner code
v2 := router.SetPrefix("/api/v2")
// Utility routes (no auth required)
v2.GET("/time", timeHandler)
// Future v2 routes can be added here easily:
// v2.GET("/status", statusHandler)
// v2.GET("/health", healthHandler)
```

## 9.Going to production
# Going to production
Going to production  ### Deployment strategies
##### Minimal setup
One of the best PocketBase features is that it&#39;s completely portable. This means that it doesn&#39;t require
any external dependency and
could be deployed by just uploading the executable on your server.
Here is an example of starting a production HTTPS server (auto managed TLS with Let&#39;s Encrypt) on a clean
Ubuntu 22.04 installation.
-Consider the following app directory structure:
myapp/
pb_migrations/
pb_hooks/
pocketbase
-Upload the binary and anything else required by your application to your remote server, for
example using
rsync:
rsync -avz -e ssh /local/path/to/myapp root@YOUR_SERVER_IP:/root/pb
-Start a SSH session with your server:
ssh root@YOUR_SERVER_IP
-Start the executable (specifying a domain name will issue a Let&#39;s encrypt certificate for it)
[root@dev ~]$ /root/pb/pocketbase serve yourdomain.com  Notice that in the above example we are logged in as root which allows us to
bind to the
privileged 80 and 443 ports.
For non-root users usually you&#39;ll need special privileges to be able to do
that. You have several options depending on your OS - authbind,
setcap,
iptables, sysctl, etc. Here is an example using setcap:
[myuser@dev ~]$ sudo setcap 'cap_net_bind_service=+ep' /root/pb/pocketbase
-(Optional) Systemd service
You can skip step 3 and create a Systemd service
to allow your application to start/restart on its own.
Here is an example service file (usually created in
/lib/systemd/system/pocketbase.service):
[Unit]
Description = pocketbase
[Service]
Type             = simple
User             = root
Group            = root
LimitNOFILE      = 4096
Restart          = always
RestartSec       = 5s
StandardOutput   = append:/root/pb/std.log
StandardError    = append:/root/pb/std.log
WorkingDirectory = /root/pb
ExecStart        = /root/pb/pocketbase serve yourdomain.com
[Install]
WantedBy = multi-user.target  After that we just have to enable it and start the service using systemctl:
[root@dev ~]$ systemctl enable pocketbase.service
[root@dev ~]$ systemctl start pocketbase  You can find a link to the Web UI installer in the /root/pb/std.log, but
alternatively you can also create the first superuser explicitly via the
superuser PocketBase command:
[root@dev ~]$ /root/pb/pocketbase superuser create EMAIL PASS
##### Using reverse proxy
If you plan on hosting multiple applications on a single server or need finer network controls, you can
always put PocketBase behind a reverse proxy such as
NGINX, Apache, Caddy, etc.
Just note that when using a reverse proxy you may need to set up the &quot;User IP proxy headers&quot; in the
PocketBase settings so that the application can extract and log the actual visitor/client IP (the
headers are usually X-Real-IP, X-Forwarded-For).
Here is a minimal NGINX example configuration:
server {
listen 80;
client_max_body_size 10M;
location / {
# check http://nginx.org/en/docs/http/ngx_http_upstream_module.html#keepalive
proxy_set_header Connection '';
proxy_http_version 1.1;
proxy_read_timeout 360s;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
# enable if you are serving under a subpath location
# rewrite /yourSubpath/(.*) /$1  break;
proxy_pass http://127.0.0.1:8090;
}  Corresponding Caddy configuration is:
request_body {
max_size 10MB
reverse_proxy 127.0.0.1:8090 {
transport http {
read_timeout 360s
}  ##### Using Docker
Some hosts (e.g. fly.io) use Docker
for deployments. PocketBase doesn&#39;t have an official Docker image, but you could use the below minimal
Dockerfile as an example:
FROM alpine:latest
ARG PB_VERSION=0.30.2
RUN apk add --no-cache \
unzip \
ca-certificates
# uncomment to copy the local pb_migrations dir into the image
# COPY ./pb_migrations /pb/pb_migrations
# uncomment to copy the local pb_hooks dir into the image
# COPY ./pb_hooks /pb/pb_hooks
EXPOSE 8080
# start PocketBase
CMD ["/pb/pocketbase", "serve", "--http=0.0.0.0:8080"]  To persist your data you need to mount a volume at /pb/pb_data.
For a full example you could check the
&quot;Host for free on Fly.io&quot;
guide.
### Backup and Restore
To backup/restore your application it is enough to manually copy/replace your pb_data
directory
(for transactional safety make sure that the application is not running).
To make things slightly easier, PocketBase v0.16+ comes with builtin backups and restore APIs that could
be accessed from the Dashboard (
Settings > Backups
Backups can be stored locally (default) or in a S3 compatible storage (it is recommended to use a separate bucket only for the backups). The generated backup represents a full snapshot as ZIP archive of your pb_data directory (including
the locally stored uploaded files but excluding any local backups or files uploaded to S3).
During the backup&#39;s ZIP generation the application will be temporary set in read-only mode.
Depending on the size of your pb_data this could be a very slow operation and it is
advised in case of large pb_data (e.g. 2GB+) to consider a different backup strategy
(see an example
backup.sh script
that combines sqlite3 .backup + rsync)
### Recommendations
By default, PocketBase uses the internal Unix sendmail command for sending emails.
While it&#39;s OK for development, it&#39;s not very useful for production, because your emails most likely will get
marked as spam or even fail to deliver.
To avoid deliverability issues, consider using a local SMTP server or an external mail service like
MailerSend,
Brevo,
SendGrid,
Mailgun,
AWS SES, etc.
Once you&#39;ve decided on a mail service, you could configure the PocketBase SMTP settings from the
Dashboard > Settings > Mail settings :
As an additional layer of security you can enable the MFA and OTP options for the _superusers
collection, which will enforce an additional one-time password (email code) requirement when authenticating
as superuser.
In case of email deliverability issues, you can also generate an OTP manually using the
To minimize the risk of API abuse (e.g. excessive auth or record create requests) it is recommended to set
up a rate limiter.
PocketBase v0.23.0+ comes with a simple builtin rate limiter that should cover most of the cases but you
are also free to use any external one via reverse proxy if you need more advanced options.
You can configure the builtin rate limiter from the
Dashboard > Settings > Application:
Unix uses &quot;file descriptors&quot; also for network connections and most systems have a default limit
of ~ 1024.
If your application has a lot of concurrent realtime connections, it is possible that at some point you would
get an error such as: Too many open files.
One way to mitigate this is to check your current account resource limits by running
ulimit -a and find the parameter you want to change. For example, if you want to increase the
open files limit (-n), you could run
ulimit -n 4096 before starting PocketBase.
If you are running in a memory constrained environment, defining the
GOMEMLIMIT
environment variable could help preventing out-of-memory (OOM) termination of your process. It is a &quot;soft limit&quot;
meaning that the memory usage could still exceed it in some situations, but it instructs the GC to be more
&quot;aggressive&quot; and run more often if needed. For example: GOMEMLIMIT=512MiB.
If after GOMEMLIMIT you are still experiencing OOM errors, you can try to enable swap
partitioning (if not already) or open a
Q&amp;A discussion
with some steps to reproduce the error in case it is something that we can improve in PocketBase.
It is fine to ignore the below if you are not sure whether you need it.
By default, PocketBase stores the applications settings in the database as plain JSON text, including the
SMTP password and S3 storage credentials.
While this is not a security issue on its own (PocketBase applications live entirely on a single server
and it is expected only authorized users to have access to your server and application data), in some
situations it may be a good idea to store the settings encrypted in case someone get their hands on your
database file (e.g. from an external stored backup).
To store your PocketBase settings encrypted:
-Create a new environment variable and set a random 32 characters string as its value.
e.g. add
export PB_ENCRYPTION_KEY=&quot;mqnMUCRxQ9BHLB1QIzpsFxzX6IxWtkEU&quot;
in your shell profile file
-Start the application with --encryptionEnv=YOUR_ENV_VAR flag.
e.g. pocketbase serve --encryptionEnv=PB_ENCRYPTION_KEY

## 10.pb-deployer - PocketBase Production Deployment
<div align="center">
<img src="frontend/static/favicon.svg" alt="Logo" width="200">
<h1 align="center">pb-deployer</h1>
<h3 align="center">Automates the lifecycle of deploying PocketBase apps to production</h3>
<a href="https://github.com/magooney-loon/pb-deployer/stargazers"><img src="https://img.shields.io/github/stars/magooney-loon/pb-deployer?style=for-the-badge&color=blue" alt="Stargazers"></a>
<a href="https://github.com/magooney-loon/pb-deployer/graphs/contributors"><img src="https://img.shields.io/github/contributors/magooney-loon/pb-deployer?style=for-the-badge&color=blue" alt="Contributors"></a>
<a href="https://github.com/magooney-loon/pb-deployer/blob/main/LICENSE"><img src="https://img.shields.io/github/license/magooney-loon/pb-deployer?style=for-the-badge&color=blue" alt="AGPL-3.0"></a>
<br>
<img src="frontend/static/deployer.png" alt="Screenshot" width="100%">
<h5 align="center">**WARNING**HOBBY PROJECT**</h5>
<a target="_blank" href="https://magooney.org/">Web Demo UI</a>
</div>
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/magooney-loon/pb-deployer)
## 🚀 Quick Start
```bash
git clone https://github.com/magooney-loon/pb-deployer
cd pb-deployer
go run cmd/scripts/main.go --install
```
## Core Workflow
1. **Server Registration**: Add remote host connection details
2. **Server Setup**: Automated user creation and directory structure
3. **Security Lockdown**: Firewall, fail2ban, disable root SSH (Optional)
4. **App Deployment**: Upload prod dist, systemd service creation
5. **Version Management**: Rollback support with file storage
## Directory Structure
```
/opt/pocketbase/
├── apps/           # Application deployments (per app directory)
├── backups/        # Deployment backups (timestamped)
├── logs/           # Application logs
└── staging/        # Temporary staging during deployments
```
## Deployment Steps
2. **Checking service status**
3. **Stopping existing service**
4. **Creating backup of current deployment**
5. **Preparing deployment directory**
6. **Installing new version**
7. **Creating/updating systemd service**
8. **Creating superuser (if initial deployment)**
9. **Starting service**
10. **Verifying & finalizing deployment**
<div align="center">
<img src="frontend/static/deployer2.png" alt="Logo" width="100%">
</div>
See `**/*/README.md` for detailed docs.
Make sure you loaded your SSH keys, check with `ssh-add -l`
## Contribution

## 11.Introduction - Collections
Response 200:
{"slug:autogenerate":"abc-"}
Response 200:
{"permissions+": "optionA", "roles-": ["staff", "editor"]}
Response 200:
{"documents+": new File(...), "documents-": ["file1_Ab24ZjL.txt", "file2_Frq24ZjL.txt"]}
Response 200:
{"users+": "USER_ID", "categories-": ["CAT_ID1", "CAT_ID2"]}
Response 200:
{"lon":12.34,"lat":56.78}
- Collections
Collections  ### Overview
Collections represent your application data. Under the hood they are backed by plain
SQLite tables that are generated automatically with the collection
name and fields (columns).
Single entry of a collection is called record (a single row in the SQL table).
You can manage your collections from the Dashboard, with the Web APIs using the
client-side SDKs
(superusers only) or programmatically via the
Go/JavaScript
migrations.
Similarly, you can manage your records from the Dashboard, with the Web APIs using the
client-side SDKs
or programmatically via the
Go/JavaScript
Record operations.
Here is what a collection edit panel looks like in the Dashboard:
Currently there are 3 collection types: Base, View and
Auth.
##### Base collection
Base collection is the default collection type and it could be used to store any application
data (articles, products, posts, etc.).
##### View collection
View collection is a read-only collection type where the data is populated from a plain
SQL SELECT statement, allowing users to perform aggregations or any other custom queries in
general.
For example, the following query will create a read-only collection with 3 posts
fields - id, name and totalComments:
SELECT
posts.id,
posts.name,
count(comments.id) as totalComments
FROM posts
LEFT JOIN comments on comments.postId = posts.id
GROUP BY posts.id   View collections don&#39;t receive realtime events because they don&#39;t have create/update/delete
operations. ##### Auth collection
Auth collection has everything from the Base collection but with some additional
special fields to help you manage your app users and also provide various authentication options.
Each Auth collection has the following special system fields:
email, emailVisibility, verified,
password and tokenKey.
They cannot be renamed or deleted but can be configured using their specific field options. For example you
can make the user email required or optional.
You can have as many Auth collections as you want (users, managers, staffs, members, clients, etc.) each
with their own set of fields, separate login and records managing endpoints.
You can build all sort of different access controls:
-Role (Group)  For example, you could attach a &quot;role&quot; select field to your Auth collection with the
following options: &quot;employee&quot; and &quot;staff&quot;. And then in some of your other collections you could
define the following rule to allow only &quot;staff&quot;:
@request.auth.role = &quot;staff&quot;
-Relation (Ownership)  Let&#39;s say that you have 2 collections - &quot;posts&quot; base collection and &quot;users&quot; auth collection. In
your &quot;posts&quot; collection you can create &quot;author&quot;
relation field pointing to the &quot;users&quot; collection. To allow access to only the
&quot;author&quot; of the record(s), you could use a rule like:
@request.auth.id != &quot;&quot; &amp;&amp; author = @request.auth.id
Nested relation fields look ups, including back-relations, are also supported, for example:
someRelField.anotherRelField.author = @request.auth.id
-Managed  In addition to the default &quot;List&quot;, &quot;View&quot;, &quot;Create&quot;, &quot;Update&quot;, &quot;Delete&quot; API rules, Auth
collections have also a special &quot;Manage&quot; API rule that could be used to allow one user (it could
be even from a different collection) to be able to fully manage the data of another user (e.g.
changing their email, password, etc.).
-Mixed  You can build a mixed approach based on your unique use-case. Multiple rules can be grouped with
parenthesis () and combined with &amp;&amp;
(AND) and || (OR) operators:
@request.auth.id != &quot;&quot; &amp;&amp; (@request.auth.role = &quot;staff&quot; || author = @request.auth.id)
### Fields
All collection fields (with exception of the JSONField) are
non-nullable and use a zero-default for their respective type as fallback value
when missing (empty string for text, 0 for number, etc.).
All field specific modifiers are supported both in the Web APIs and via the record Get/Set
methods.
BoolField    BoolField defines bool type field to store a single false
(default) or true value.
NumberField    NumberField defines number type field for storing numeric/float64 value:
0 (default), 2, -1, 1.5.
The following additional set modifiers are available:
-fieldName+
adds number to the already existing record value.
-fieldName-
subtracts number from the already existing record value.
TextField    TextField defines text type field for storing string values:
&quot;&quot; (default), &quot;example&quot;.
The following additional set modifiers are available:
-fieldName:autogenerate
autogenerate a field value if the AutogeneratePattern field option is set.
For example, submitting:
{"slug:autogenerate":"abc-"} will result in &quot;abc-[random]&quot; slug field value.
EmailField    EmailField defines email type field for storing a single email string address:
URLField    URLField defines url type field for storing a single URL string value:
EditorField    EditorField defines editor type field to store HTML formatted text:
&quot;&quot; (default), &lt;p>example&lt;/p>.
DateField    DateField defines date type field to store a single datetime string value:
&quot;&quot; (default), &quot;2022-01-01 00:00:00.000Z&quot;.
All PocketBase dates at the moment follows the RFC3399 format Y-m-d H:i:s.uZ
(e.g. 2024-11-10 18:45:27.123Z).
Dates are compared as strings, meaning that when using the filters with a date field you&#39;ll
have to specify the full datetime string format. For example to target a single day (e.g.
November 19, 2024) you can use something like:
created >= '2024-11-19 00:00:00.000Z' &amp;&amp; created &lt;= '2024-11-19 23:59:59.999Z'
AutodateField    AutodateField defines an autodate type field and it is similar to the DateField but
its value is auto set on record create/update.
This field is usually used for defining timestamp fields like &quot;created&quot; and &quot;updated&quot;.
SelectField    SelectField defines select type field for storing single or multiple string values
from a predefined list.
It is usually intended for handling enums-like values such as
pending/public/private
statuses, simple client/staff/manager/admin roles, etc.
For single select (the MaxSelect option is &lt;= 1)
the field value is a string:
&quot;&quot;, &quot;optionA&quot;.
For multiple select (the MaxSelect option is >= 2)
the field value is an array:
[], [&quot;optionA&quot;, &quot;optionB&quot;].
The following additional set modifiers are available:
-fieldName+
appends one or more values to the existing one.
-+fieldName
prepends one or more values to the existing one.
-fieldName-
subtracts/removes one or more values from the existing one.
For example: {"permissions+": "optionA", "roles-": ["staff", "editor"]}
FileField    FileField defines file type field for managing record file(s).
PocketBase stores in the database only the file name. The file itself is stored either on the
local disk or in S3, depending on your application storage settings.
For single file (the MaxSelect option is &lt;= 1)
the stored value is a string:
&quot;&quot;, &quot;file1_Ab24ZjL.png&quot;.
For multiple file (the MaxSelect option is >= 2)
the stored value is an array:
[], [&quot;file1_Ab24ZjL.png&quot;, &quot;file2_Frq24ZjL.txt&quot;].
The following additional set modifiers are available:
-fieldName+
appends one or more files to the existing field value.
-+fieldName
prepends one or more files to the existing field value.
-fieldName-
deletes one or more files from the existing field value.
For example:
{"documents+": new File(...), "documents-": ["file1_Ab24ZjL.txt", "file2_Frq24ZjL.txt"]}
You can find more detailed information in the
Files upload and handling guide.
RelationField    RelationField defines relation type field for storing single or multiple collection
record references.
For single relation (the MaxSelect option is &lt;= 1)
the field value is a string:
&quot;&quot;, &quot;RECORD_ID&quot;.
For multiple relation (the MaxSelect option is >= 2)
the field value is an array:
[], [&quot;RECORD_ID1&quot;, &quot;RECORD_ID2&quot;].
The following additional set modifiers are available:
-fieldName+
appends one or more ids to the existing one.
-+fieldName
prepends one or more ids to the existing one.
-fieldName-
subtracts/removes one or more ids from the existing one.
For example: {"users+": "USER_ID", "categories-": ["CAT_ID1", "CAT_ID2"]}
JSONField    JSONField defines json type field for storing any serialized JSON value,
including null (default).
GeoPoint    GeoPoint defines geoPoint type field for storing geographic coordinates
(longitude, latitude) as a serialized json object. For example:
{"lon":12.34,"lat":56.78}.
The default/zero value of a geoPoint is the &quot;Null Island&quot;, aka.
{"lon":0,"lat":0}.
When extending PocketBase with Go/JSVM, the geoPoint field value could be set as
types.GeoPoint instance or a regular map with lon and
lat keys:
JavaScript  // set types.GeoPoint
record.Set("address", types.GeoPoint{Lon:12.34, Lat:45.67})
// set map[string]any
record.Set("address", map[string]any{"lon":12.34, "lat":45.67})
// retrieve the field value as types.GeoPoint struct
address := record.GetGeoPoint("address")  record.set("address", {"lon":12.34, "lat":45.67})
const address = record.get("address")

## 12.Introduction - API rules and filters
- API rules and filters
API rules and filters  ### API rules
API Rules are your collection access controls and data filters.
Each collection has 5 rules, corresponding to the specific API action:
-listRule
-viewRule
-createRule
-updateRule
-deleteRule
Auth collections have an additional options.manageRule used to allow one user (it could be even
from a different collection) to be able to fully manage the data of another user (ex. changing their email,
password, etc.).
Each rule could be set to:
-&quot;locked&quot; - aka. null, which means that the action could be performed
only by an authorized superuser
(this is the default)
-Empty string - anyone will be able to perform the action (superusers, authorized users
and guests)
-Non-empty string - only users (authorized or not) that satisfy the rule filter expression
will be able to perform this action
PocketBase API Rules act also as records filter!
Or in other words, you could for example allow listing only the &quot;active&quot; records of your collection,
by using a simple filter expression such as:
status = &quot;active&quot;
(where &quot;status&quot; is a field defined in your Collection).
Because of the above, the API will return 200 empty items response in case a request doesn&#39;t
satisfy a listRule, 400 for unsatisfied createRule and 404 for
unsatisfied viewRule, updateRule and deleteRule.
All rules will return 403 in case they were &quot;locked&quot; (aka. superuser only) and the request client is
not a superuser.
The API Rules are ignored when the action is performed by an authorized superuser (superusers can access everything)!
### Filters syntax
You can find information about the available fields in your collection API rules tab:
There is autocomplete to help guide you while typing the rule filter expression, but in general you have
access to 3 groups of fields:
-Your Collection schema fields
This includes all nested relation fields too, ex.
someRelField.status != &quot;pending&quot;
-@request.*
Used to access the current request data, such as query parameters, body/form fields, authorized user state,
etc.
@request.context - the context where the rule is used (ex.
@request.context != &quot;oauth2&quot;)
The currently supported context values are
default,
oauth2,
otp,
password,
realtime,
protectedFile.
-@request.method - the HTTP request method (ex.
@request.method = &quot;GET&quot;)
-@request.headers.* - the request headers as string values (ex.
@request.headers.x_token = &quot;test&quot;)
Note: All header keys are normalized to lowercase and &quot;-&quot; is replaced with &quot;_&quot; (for
example &quot;X-Token&quot; is &quot;x_token&quot;).
-@request.query.* - the request query parameters as string values (ex.
@request.query.page = &quot;1&quot;)
-@request.auth.* - the current authenticated model (ex.
@request.auth.id != &quot;&quot;)
-@request.body.* - the submitted body parameters (ex.
@request.body.title != &quot;&quot;)
Note: Uploaded files are not part of the @request.body
because they are evaluated separately (this behavior may change in the future).
-@collection.* This filter could be used to target other collections that are not directly related to the current
one (aka. there is no relation field pointing to it) but both shares a common field value, like
for example a category id:
@collection.news.categoryId ?= categoryId &amp;&amp; @collection.news.author ?= @request.auth.id  In case you want to join the same collection multiple times but based on different criteria, you
can define an alias by appending :alias suffix to the collection name.
// see https://github.com/pocketbase/pocketbase/discussions/3805#discussioncomment-7634791
@request.auth.id != "" &amp;&amp;
@collection.courseRegistrations.user ?= id &amp;&amp;
@collection.courseRegistrations:auth.user ?= @request.auth.id &amp;&amp;
@collection.courseRegistrations.courseGroup ?= @collection.courseRegistrations:auth.courseGroup
The syntax basically follows the format
OPERAND OPERATOR OPERAND, where:
-OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false
-OPERATOR - is one of:
= Equal
-!= NOT equal
-> Greater than
->= Greater than or equal
-&lt; Less than
-&lt;= Less than or equal
-~ Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-!~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
-?= Any/At least one of Equal
-?!= Any/At least one of NOT equal
-?> Any/At least one of Greater than
-?>= Any/At least one of Greater than or equal
-?&lt; Any/At least one of Less than
-?&lt;= Any/At least one of Less than or equal
-?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
To group and combine several expressions you can use parenthesis
(...), &amp;&amp; (AND) and || (OR) tokens.
Single line comments are also supported: // Example comment.
### Special identifiers and modifiers
##### @ macros
The following datetime macros are available and can be used as part of the filter expression:
// all macros are UTC based
@now        - the current datetime as string
@second     - @now second number (0-59)
@minute     - @now minute number (0-59)
@hour       - @now hour number (0-23)
@weekday    - @now weekday number (0-6)
@day        - @now day number
@month      - @now month number
@year       - @now year number
@yesterday  - the yesterday datetime relative to @now as string
@tomorrow   - the tomorrow datetime relative to @now as string
@todayStart - beginning of the current day as datetime string
@todayEnd   - end of the current day as datetime string
@monthStart - beginning of the current month as datetime string
@monthEnd   - end of the current month as datetime string
@yearStart  - beginning of the current year as datetime string
@yearEnd    - end of the current year as datetime string  For example:
`@request.body.publicDate >= @now`  ##### :isset modifier
The :isset field modifier is available only for the @request.* fields and can be
used to check whether the client submitted a specific data with the request. Here is for example a rule that
disallows changing a &quot;role&quot; field:
`@request.body.role:isset = false`  Note that @request.body.*:isset at the moment doesn&#39;t support checking for
new uploaded files because they are evaluated separately and cannot be serialized (this behavior may change in the future).
##### :length modifier
The :length field modifier could be used to check the number of items in an array field
(multiple file, select, relation).
Could be used with both the collection schema fields and the @request.body.* fields. For example:
// check example submitted data: {"someSelectField": ["val1", "val2"]}
@request.body.someSelectField:length > 1
// check existing record field length
someRelationField:length = 2  Note that @request.body.*:length at the moment doesn&#39;t support checking
for new uploaded files because they are evaluated separately and cannot be serialized (this behavior may change in the future).
##### :each modifier
The :each field modifier works only with multiple select, file and
relation
type fields. It could be used to apply a condition on each item from the field array. For example:
// check if all submitted select options contain the "create" text
@request.body.someSelectField:each ~ "create"
// check if all existing someSelectField has "pb_" prefix
someSelectField:each ~ "pb_%"  Note that @request.body.*:each at the moment doesn&#39;t support checking for
new uploaded files because they are evaluated separately and cannot be serialized (this behavior may change in the future).
##### :lower modifier
The :lower field modifier could be used to perform lower-case string comparisons. For example:
// check if the submitted lower-cased body "title" field is equal to "test" ("Test", "tEsT", etc.)
@request.body.title:lower = "test"
// match existing records with lower-cased "title" equal to "test" ("Test", "tEsT", etc.)
title:lower ~ "test"  Under the hood it uses the
SQLite LOWER scalar function
and by default works only for ASCII characters, unless the ICU extension is loaded.
##### geoDistance(lonA, latA, lonB, latB)
The geoDistance(lonA, latA, lonB, latB) function could be used to calculate the Haversine distance
between 2 geographic points in kilometres.
The function is intended to be used primarily with the geoPoint field type, but the accepted
arguments could be any plain number or collection field identifier. If the identifier cannot be resolved
and converted to a numeric value, it resolves to null. Note that the
geoDistance function always results in a single row/record value meaning that &quot;any/at-least-one-of&quot;
type of constraint will be applied even if some of its arguments originate from a multiple relation field.
For example:
// offices that are less than 25km from my location (address is a geoPoint field in the offices collection)
geoDistance(address.lon, address.lat, 23.32, 42.69) &lt; 25  #
-Allow only registered users:
@request.auth.id != ""
-Allow only registered users and return records that are either &quot;active&quot; or &quot;pending&quot;:
@request.auth.id != "" &amp;&amp; (status = "active" || status = "pending")
-Allow only registered users who are listed in an allowed_users multi-relation field value:
@request.auth.id != "" &amp;&amp; allowed_users.id ?= @request.auth.id
-Allow access by anyone and return only the records where the title field value starts with
title ~ "Lorem%"

## 13.Introduction - Working with relations
- Working with relations
Working with relations  ### Overview
Let&#39;s assume that we have the following collections structure:
The relation fields follow the same rules as any other collection field and can be set/modified
by directly updating the field value - with a record id or array of ids, in case a multiple relation is used.
Below is an example that shows creating a new posts record with 2 assigned tags.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const post = await pb.collection('posts').create({
'tags':  ['TAG_ID1', 'TAG_ID2'],
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final post = await pb.collection('posts').create(body: {
'tags':  ['TAG_ID1', 'TAG_ID2'],
});   ### Prepend/Append to multiple relation
To prepend/append a single or multiple relation id(s) to an existing value you can use the
+ field modifier:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const post = await pb.collection('posts').update('POST_ID', {
// prepend single tag
'+tags': 'TAG_ID1',
// append multiple tags at once
'tags+': ['TAG_ID1', 'TAG_ID2'],
})  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final post = await pb.collection('posts').update('POST_ID', body: {
// prepend single tag
'+tags': 'TAG_ID1',
// append multiple tags at once
'tags+': ['TAG_ID1', 'TAG_ID2'],
})   ### Remove from multiple relation
To remove a single or multiple relation id(s) from an existing value you can use the
- field modifier:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const post = await pb.collection('posts').update('POST_ID', {
// remove single tag
'tags-': 'TAG_ID1',
// remove multiple tags at once
'tags-': ['TAG_ID1', 'TAG_ID2'],
})  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final post = await pb.collection('posts').update('POST_ID', body: {
// remove single tag
'tags-': 'TAG_ID1',
// remove multiple tags at once
'tags-': ['TAG_ID1', 'TAG_ID2'],
})   ### Expanding relations
You can also expand record relation fields directly in the returned response without making additional
requests by using the expand query parameter, e.g. ?expand=user,post.tags
Only the relations that the request client can View (aka. satisfies the relation
collection&#39;s View API Rule) will be expanded.
Nested relation references in expand, filter or sort are supported
via dot-notation and up to 6-levels depth.
For example, to list all comments with their user relation expanded, we can
do the following:
Dart  `await pb.collection("comments").getList(1, 30, { expand: "user" })`  `await pb.collection("comments").getList(perPage: 30, expand: "user")`   {
"page": 1,
"perPage": 30,
"totalPages": 1,
"totalItems": 20,
"items": [
"id": "lmPJt4Z9CkLW36z",
"collectionId": "BHKW36mJl3ZPt6z",
"collectionName": "comments",
"created": "2022-01-01 01:00:00.456Z",
"updated": "2022-01-01 02:15:00.456Z",
"post": "WyAw4bDrvws6gGl",
"user": "FtHAW9feB5rze7D",
"message": "Example message...",
"expand": {
"user": {
"id": "FtHAW9feB5rze7D",
"collectionId": "srmAo0hLxEqYF7F",
"collectionName": "users",
"created": "2022-01-01 00:00:00.000Z",
"updated": "2022-01-01 00:00:00.000Z",
"username": "users54126",
"verified": false,
"emailVisibility": false,
"name": "John Doe"
}  ### Back-relations
PocketBase supports also filter, sort and expand for
back-relations
- relations where the associated relation field is not in the main collection.
The following notation is used: referenceCollection_via_relField (ex.
comments_via_post).
For example, let&#39;s list the posts that have at least one comments record
containing the word &quot;hello&quot;:
Dart  await pb.collection("posts").getList(1, 30, {
filter: "comments_via_post.message ?~ 'hello'"
expand: "comments_via_post.user",
})  await pb.collection("posts").getList(
perPage: 30,
filter: "comments_via_post.message ?~ 'hello'"
expand: "comments_via_post.user",
)   {
"page": 1,
"perPage": 30,
"totalPages": 2,
"totalItems": 45,
"items": [
"id": "WyAw4bDrvws6gGl",
"collectionName": "posts",
"created": "2022-01-01 01:00:00.456Z",
"updated": "2022-01-01 02:15:00.456Z",
"expand": {
"comments_via_post": [
"id": "lmPJt4Z9CkLW36z",
"collectionId": "BHKW36mJl3ZPt6z",
"collectionName": "comments",
"created": "2022-01-01 01:00:00.456Z",
"updated": "2022-01-01 02:15:00.456Z",
"post": "WyAw4bDrvws6gGl",
"user": "FtHAW9feB5rze7D",
"expand": {
"user": {
"id": "FtHAW9feB5rze7D",
"collectionId": "srmAo0hLxEqYF7F",
"collectionName": "users",
"created": "2022-01-01 00:00:00.000Z",
"updated": "2022-01-01 00:00:00.000Z",
"username": "users54126",
"verified": false,
"emailVisibility": false,
"name": "John Doe"
"id": "tu4Z9CkLW36mPJz",
"collectionId": "BHKW36mJl3ZPt6z",
"collectionName": "comments",
"created": "2022-01-01 01:10:00.123Z",
"updated": "2022-01-01 02:39:00.456Z",
"post": "WyAw4bDrvws6gGl",
"user": "FtHAW9feB5rze7D",
"message": "hello...",
"expand": {
"user": {
"id": "FtHAW9feB5rze7D",
"collectionId": "srmAo0hLxEqYF7F",
"collectionName": "users",
"created": "2022-01-01 00:00:00.000Z",
"updated": "2022-01-01 00:00:00.000Z",
"username": "users54126",
"verified": false,
"emailVisibility": false,
"name": "John Doe"
}  ###### Back-relation caveats
-By default the back-relation reference is resolved as a dynamic
multiple relation field, even when the back-relation field itself is marked as
single.
This is because the main record could have more than one single
back-relation reference (see in the above example that the comments_via_post
expand is returned as array, although the original comments.post field is a
single relation).
The only case where the back-relation will be treated as a single
relation field is when there is
UNIQUE index constraint defined on the relation field.
-Back-relation expand is limited to max 1000 records per relation field. If you
need to fetch larger number of back-related records a better approach could be to send a
separate paginated getList() request to the back-related collection to avoid transferring
large JSON payloads and to reduce the memory usage.

## 14.Introduction - Authentication
- Authentication
Authentication  ### Overview
A single client is considered authenticated as long as it sends valid
Authorization:YOUR_AUTH_TOKEN header with the request.
The PocketBase Web APIs are fully stateless and there are no sessions in the traditional sense (even the
tokens are not stored in the database).
Because there are no sessions and we don&#39;t store the tokens on the server there is also no logout
endpoint. To &quot;logout&quot; a user you can simply disregard the token from your local state (aka.
pb.authStore.clear() if you use the SDKs).
The auth token could be generated either through the specific auth collection Web APIs or programmatically
via Go/JS.
All allowed auth collection methods can be configured individually from the specific auth collection
options.
Note that PocketBase admins (aka. _superusers) are similar to the regular auth
collection records with 2 caveats:
-OAuth2 is not supported as auth method for the _superusers collection
-Superusers can access and modify anything (collection API rules are ignored)
### Authenticate with password
To authenticate with password you must enable the Identity/Password auth collection option
(see also
Web API reference
The default identity field is the email but you can configure any other unique field like
&quot;username&quot; (it must have a UNIQUE index).
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// after the above you can also access the auth data from the authStore
console.log(pb.authStore.isValid);
console.log(pb.authStore.token);
console.log(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// after the above you can also access the auth data from the authStore
print(pb.authStore.isValid);
print(pb.authStore.token);
print(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();   ### Authenticate with OTP
To authenticate with email code you must enable the One-time password (OTP)
auth collection option
(see also
Web API reference
The usual flow is the user typing manually the received password from their email but you can also
adjust the default email template from the collection options and add a url containing the OTP and its
id as query parameters
Note that when requesting an OTP we return an otpId even if a user with the provided email
doesn&#39;t exist as a very rudimentary enumeration protection (it doesn&#39;t create or send anything).
On successful OTP validation, by default the related user email will be automatically marked as
&quot;verified&quot;.
Keep in mind that OTP as a standalone authentication method could be less secure compared to the
other methods because the generated password is usually 0-9 digits and there is a risk of it being
guessed or enumerated (especially when a longer duration time is configured).
For security critical applications OTP is recommended to be used in combination with the other
auth methods and the Multi-factor authentication option.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// send OTP email to the provided auth record
// ... show a screen/popup to enter the password from the email ...
// authenticate with the requested OTP id and the email password
const authData = await pb.collection('users').authWithOTP(result.otpId, "YOUR_OTP");
// after the above you can also access the auth data from the authStore
console.log(pb.authStore.isValid);
console.log(pb.authStore.token);
console.log(pb.authStore.record.id);
// "logout"
pb.authStore.clear();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// send OTP email to the provided auth record
// ... show a screen/popup to enter the password from the email ...
// authenticate with the requested OTP id and the email password
final authData = await pb.collection('users').authWithOTP(result.otpId, "YOUR_OTP");
// after the above you can also access the auth data from the authStore
print(pb.authStore.isValid);
print(pb.authStore.token);
print(pb.authStore.record.id);
// "logout"
pb.authStore.clear();   ### Authenticate with OAuth2
You can also authenticate your users with an OAuth2 provider (Google, GitHub, Microsoft, etc.). See the
section below for example integrations.
Before starting, you&#39;ll need to create an OAuth2 app in the provider&#39;s dashboard in order to get a
Client Id and Client Secret, and register a redirect URL
Once you have obtained the Client Id and Client Secret, you can
enable and configure the provider from your PocketBase auth collection options (PocketBase > Collections > {YOUR_COLLECTION} > Edit collection (settings cogwheel) > Options
> OAuth2).
This method handles everything within a single call without having to define custom redirects,
deeplinks or even page reload.
When creating your OAuth2 app, for a callback/redirect URL you have to use the
https://yourdomain.com/api/oauth2-redirect
(or when testing locally - http://127.0.0.1:8090/api/oauth2-redirect ).
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('https://pocketbase.io');
// This method initializes a one-off realtime subscription and will
// open a popup window with the OAuth2 vendor page to authenticate.
// Once the external OAuth2 sign-in/sign-up flow is completed, the popup
// window will be automatically closed and the OAuth2 data sent back
// If the popup is being blocked on Safari, make sure that your click handler is not using async/await.
pb.collection('users').authWithOAuth2({
provider: 'google'
}).then((authData) => {
console.log(authData)
// after the above you can also access the auth data from the authStore
console.log(pb.authStore.isValid);
console.log(pb.authStore.token);
console.log(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();
});  import 'package:pocketbase/pocketbase.dart';
import 'package:url_launcher/url_launcher.dart';
final pb = PocketBase('https://pocketbase.io');
// This method initializes a one-off realtime subscription and will
// call the provided urlCallback with the OAuth2 vendor url to authenticate.
// Once the external OAuth2 sign-in/sign-up flow is completed, the browser
// window will be automatically closed and the OAuth2 data sent back
// Note that it requires the app and realtime connection to remain active in the background!
// For Android 15+ check the note in https://github.com/pocketbase/dart-sdk#oauth2-and-android-15.
final authData = await pb.collection('users').authWithOAuth2('google', (url) async {
// or use flutter_custom_tabs to make the transitions between native and web content more seamless
await launchUrl(url);
// after the above you can also access the auth data from the authStore
print(pb.authStore.isValid);
print(pb.authStore.token);
print(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();   When authenticating manually with OAuth2 code you&#39;ll need 2 endpoints:
-somewhere to show the &quot;Login with ...&quot; links
-somewhere to handle the provider&#39;s redirect in order to exchange the auth code for token
Here is a simple web example:
-Links page
(e.g. https://127.0.0.1:8090 serving pb_public/index.html):
&lt;!DOCTYPE html>
&lt;html>
&lt;head>
&lt;meta charset="utf-8" />
&lt;meta name="viewport" content="width=device-width, initial-scale=1" />
&lt;title>OAuth2 links page&lt;/title>
&lt;script src="https://code.jquery.com/jquery-3.7.1.slim.min.js">&lt;/script>
&lt;/head>
&lt;body>
&lt;ul id="list">
&lt;li>Loading OAuth2 providers...&lt;/li>
&lt;/ul>
&lt;script type="module">
import PocketBase from "https://cdn.jsdelivr.net/gh/pocketbase/js-sdk@master/dist/pocketbase.es.mjs"
const pb          = new PocketBase("http://127.0.0.1:8090");
const redirectURL = "http://127.0.0.1:8090/redirect.html";
const authMethods = await pb.collection("users").listAuthMethods();
const providers   = authMethods.oauth2?.providers || [];
const listItems   = [];
for (const provider of providers) {
const $li = $(`&lt;li>&lt;a>Login with ${provider.name}&lt;/a>&lt;/li>`);
$li.find("a")
.attr("href", provider.authURL + redirectURL)
.data("provider", provider)
.click(function () {
// store provider's data on click for verification in the redirect page
localStorage.setItem("provider", JSON.stringify($(this).data("provider")));
listItems.push($li);
$("#list").html(listItems.length ? listItems : "&lt;li>No OAuth2 providers.&lt;/li>");
&lt;/script>
&lt;/body>
&lt;/html>
-Redirect handler page
(e.g. https://127.0.0.1:8090/redirect.html serving
pb_public/redirect.html):
&lt;!DOCTYPE html>
&lt;html>
&lt;head>
&lt;meta charset="utf-8">
&lt;title>OAuth2 redirect page&lt;/title>
&lt;/head>
&lt;body>
&lt;pre id="content">Authenticating...&lt;/pre>
&lt;script type="module">
import PocketBase from "https://cdn.jsdelivr.net/gh/pocketbase/js-sdk@master/dist/pocketbase.es.mjs"
const pb          = new PocketBase("http://127.0.0.1:8090");
const redirectURL = "http://127.0.0.1:8090/redirect.html";
const contentEl   = document.getElementById("content");
// parse the query parameters from the redirected url
const params = (new URL(window.location)).searchParams;
const provider = JSON.parse(localStorage.getItem("provider"))
// compare the redirect's state param and the stored provider's one
if (provider.state !== params.get("state")) {
contentEl.innerText = "State parameters don't match.";
} else {
// authenticate
pb.collection("users").authWithOAuth2Code(
provider.name,
params.get("code"),
provider.codeVerifier,
redirectURL,
// pass any optional user create data
emailVisibility: false,
).then((authData) => {
contentEl.innerText = JSON.stringify(authData, null, 2);
}).catch((err) => {
contentEl.innerText = "Failed to exchange code.\n" + err;
&lt;/script>
&lt;/body>
&lt;/html>
When using the &quot;Manual code exchange&quot; flow for sign-in with Apple your redirect
handler must accept POST requests in order to receive the name and the
email of the Apple user. If you just need the Apple user id, you can keep the redirect
handler GET but you&#39;ll need to replace in the Apple authorization url
response_mode=form_post with response_mode=query.
### Multi-factor authentication
PocketBase v0.23+ introduced optional Multi-factor authentication (MFA).
If enabled, it requires the user to authenticate with any 2 different auth methods from above (the
order doesn&#39;t matter).
The expected flow is:
-User authenticates with &quot;Auth method A&quot;.
-On success, a 401 response is sent with {"mfaId": "..."} as JSON body (the MFA
&quot;session&quot; is stored in the _mfas system collection).
-User authenticates with &quot;Auth method B&quot; as usual
-On success, a regular auth response is returned, aka. token + auth record data.
Below is an example for email/password + OTP authentication:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
try {
} catch (err) {
const mfaId = err.response?.mfaId;
if (!mfaId) {
throw err; // not mfa -> rethrow
// the user needs to authenticate again with another auth method, for example OTP
// ... show a modal for users to check their email and to enter the received code ...
await pb.collection('users').authWithOTP(result.otpId, 'EMAIL_CODE', { 'mfaId': mfaId });
}  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
try {
} on ClientException catch (e) {
final mfaId = e.response['mfaId'];
if (mfaId == null) {
throw e; // not mfa -> rethrow
// the user needs to authenticate again with another auth method, for example OTP
// ... show a modal for users to check their email and to enter the received code ...
await pb.collection('users').authWithOTP(result.otpId, 'EMAIL_CODE', query: { 'mfaId': mfaId });
}   ### Users impersonation
Superusers have the option to generate tokens and authenticate as anyone else via the
Impersonate endpoint
The generated impersonate auth tokens can have custom duration but are not renewable!
For convenience the official SDKs creates and returns a standalone client that keeps the token state
in memory, aka. only for the duration of the impersonate client instance.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// authenticate as superuser
// impersonate
// (the custom token duration is in seconds and it is optional)
const impersonateClient = await pb.collection("users").impersonate("USER_RECORD_ID", 3600)
// log the impersonate token and user data
console.log(impersonateClient.authStore.token);
console.log(impersonateClient.authStore.record);
// send requests as the impersonated user
const items = await impersonateClient.collection("example").getFullList();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// authenticate as superuser
// impersonate
// (the custom token duration is in seconds and it is optional)
final impersonateClient = await pb.collection("users").impersonate("USER_RECORD_ID", 3600)
// log the impersonate token and user data
print(impersonateClient.authStore.token);
print(impersonateClient.authStore.record);
// send requests as the impersonated user
final items = await impersonateClient.collection("example").getFullList();   ### API keys
While PocketBase doesn&#39;t have &quot;API keys&quot; in the traditional sense, as a side effect of the support for
users impersonation, for such cases you can use instead the generated nonrenewable
_superusers impersonate auth token.
You can generate such token via the above impersonate API or from the
Dashboard &gt; Collections &gt; _superusers &gt; {select superuser} &gt; &quot;Impersonate&quot; dropdown option:
Because of the security implications (superusers can execute, access and modify anything), use the
generated _superusers tokens with extreme care and only for internal
server-to-server communication.
To invalidate already issued tokens, you need to change the individual superuser account password
(or if you want to reset the tokens for all superusers - change the shared auth token secret from
the _superusers collection options).
### Auth token verification
PocketBase doesn&#39;t have a dedicated token verification endpoint, but if you want to verify an existing
auth token from a 3rd party app you can send an
Auth refresh
call, aka. pb.collection(&quot;users&quot;).authRefresh().
On valid token - it returns a new token with refreshed exp claim and the latest user data.
Otherwise - returns an error response.
the new one if you don&#39;t need it (as mentioned in the beginning - PocketBase doesn&#39;t store the tokens on the
server).
Performance wise, the used HS256 algorithm for generating the JWT has very little to no
impact and it is essentially the same in terms of response time as calling
getOne(&quot;USER_ID&quot;) (see
benchmarks

## 15.Introduction - Files upload and handling
- Files upload and handling
Files upload and handling  ### Uploading files
To upload files, you must first add a file field to your collection:
Once added, you could create/update a Record and upload &quot;documents&quot; files by sending a
multipart/form-data request using the Records create/update APIs.
Each uploaded file will be stored with the original filename (sanitized) and suffixed with a
random part (usually 10 characters). For example test_52iwbgds7l.png.
The max allowed size of a single file currently is limited to ~8GB (253-1 bytes).
Here is an example how to create a new record and upload multiple files to the example &quot;documents&quot;
file field using the SDKs:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// create a new record and upload multiple files
// (files must be Blob or File instances)
const createdRecord = await pb.collection('example').create({
title: 'Hello world!', // regular text field
'documents': [
new File(['content 1...'], 'file1.txt'),
new File(['content 2...'], 'file2.txt'),
// Alternative FormData + plain HTML file input example
// &lt;input type="file" id="fileInput" />
const fileInput = document.getElementById('fileInput');
const formData = new FormData();
// set regular text field
formData.append('title', 'Hello world!');
// listen to file input changes and add the selected files to the form data
fileInput.addEventListener('change', function () {
for (let file of fileInput.files) {
formData.append('documents', file);
// upload and create new record
const createdRecord = await pb.collection('example').create(formData);  import 'package:pocketbase/pocketbase.dart';
import 'package:http/http.dart' as http;
final pb = PocketBase('http://127.0.0.1:8090');
// create a new record and upload multiple files
final record = await pb.collection('example').create(
body: {
'title': 'Hello world!', // regular text field
files: [
http.MultipartFile.fromString(
'documents',
'example content 1...',
filename: 'file1.txt',
http.MultipartFile.fromString(
'documents',
'example content 2...',
filename: 'file2.txt',
);   If your file field supports uploading multiple files (aka.
Max Files option is &gt;= 2) you can use the + prefix/suffix field name modifier
to respectively prepend/append new files alongside the already uploaded ones. For example:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const createdRecord = await pb.collection('example').update('RECORD_ID', {
"documents+": new File(["content 3..."], "file3.txt")
});  import 'package:pocketbase/pocketbase.dart';
import 'package:http/http.dart' as http;
final pb = PocketBase('http://127.0.0.1:8090');
final record = await pb.collection('example').update(
'RECORD_ID',
files: [
http.MultipartFile.fromString(
'documents+',
'example content 3...',
filename: 'file3.txt',
);   ### Deleting files
To delete uploaded file(s), you could either edit the Record from the Dashboard, or use the API and set
the file field to a zero-value  (empty string, []).
If you want to delete individual file(s) from a multiple file upload field, you could
suffix the field name with - and specify the filename(s) you want to delete. Here are some examples
using the SDKs:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// delete all "documents" files
await pb.collection('example').update('RECORD_ID', {
'documents': [],
// delete individual files
await pb.collection('example').update('RECORD_ID', {
'documents-': ["file1.pdf", "file2.txt"],
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// delete all "documents" files
await pb.collection('example').update('RECORD_ID', body: {
'documents': [],
// delete individual files
await pb.collection('example').update('RECORD_ID', body: {
'documents-': ["file1.pdf", "file2.txt"],
});   The above examples use the JSON object data format, but you could also use FormData instance
for multipart/form-data requests. If using
FormData set the file field to an empty string.
### File URL
Each uploaded file could be accessed by requesting its file url:
http://127.0.0.1:8090/api/files/COLLECTION_ID_OR_NAME/RECORD_ID/FILENAME
If your file field has the Thumb sizes option, you can get a thumb of the image file by
adding the thumb
query parameter to the url like this:
http://127.0.0.1:8090/api/files/COLLECTION_ID_OR_NAME/RECORD_ID/FILENAME?thumb=100x300  Currently limited to jpg, png, gif (its first frame) and partially webp (stored as png).
The following thumb formats are currently supported:
-WxH
(e.g. 100x300) - crop to WxH viewbox (from center)
-WxHt
(e.g. 100x300t) - crop to WxH viewbox (from top)
-WxHb
(e.g. 100x300b) - crop to WxH viewbox (from bottom)
-WxHf
(e.g. 100x300f) - fit inside a WxH viewbox (without cropping)
-0xH
(e.g. 0x300) - resize to H height preserving the aspect ratio
-Wx0
(e.g. 100x0) - resize to W width preserving the aspect ratio
The original file would be returned, if the requested thumb size is not found or the file is not an image!
If you already have a Record model instance, the SDKs provide a convenient method to generate a file url
by its name.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const record = await pb.collection('example').getOne('RECORD_ID');
// get only the first filename from "documents"
// note:
// "documents" is an array of filenames because
// the "documents" field was created with "Max Files" option > 1;
// if "Max Files" was 1, then the result property would be just a string
const firstFilename = record.documents[0];
// returns something like:
// http://127.0.0.1:8090/api/files/example/kfzjt5oy8r34hvn/test_52iWbGinWd.png?thumb=100x250
const url = pb.files.getURL(record, firstFilename, {'thumb': '100x250'});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final record = await pb.collection('example').getOne('RECORD_ID');
// get only the first filename from "documents"
// note:
// "documents" is an array of filenames because
// the "documents" field was created with "Max Files" option > 1;
// if "Max Files" was 1, then the result property would be just a string
final firstFilename = record.getListValue&lt;String>('documents')[0];
// returns something like:
// http://127.0.0.1:8090/api/files/example/kfzjt5oy8r34hvn/test_52iWbGinWd.png?thumb=100x250
### Protected files
By default all files are publicly accessible if you know their full url.
For most applications this is fine and reasonably safe because all files have a random part appended to
their name, but in some cases you may want an extra security to prevent unauthorized access to sensitive
files like ID card or Passport copies, contracts, etc.
To do this you can mark the file field as Protected from its field options in the
Dashboard and then request the file with a special short-lived file token.
Only requests that satisfy the View API rule of the record collection will be able
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// authenticate
// generate a file token
const fileToken = await pb.files.getToken();
// retrieve an example protected file url (will be valid ~2min)
const record = await pb.collection('example').getOne('RECORD_ID');
const url = pb.files.getURL(record, record.myPrivateFile, {'token': fileToken});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// authenticate
// generate a file token
final fileToken = await pb.files.getToken();
// retrieve an example protected file url (will be valid ~2min)
final record = await pb.collection('example').getOne('RECORD_ID');
final url = pb.files.getURL(record, record.getStringValue('myPrivateFile'), token: fileToken);   ### Storage options
By default PocketBase stores uploaded files in the pb_data/storage directory on the local file
system. For the majority of cases this is usually the recommended storage option because it is very fast, easy
to work with and backup.
But if you have limited disk space you could switch to an external S3 compatible storage (AWS S3, MinIO,
Wasabi, DigitalOcean Spaces, Vultr Object Storage, etc.). The easiest way to set up the connection
settings is from the Dashboard &gt; Settings &gt; Files storage:

## 16.Web APIs reference - API Collections
page(Number):The page (aka. offset) of the paginated list (default to 1).
perPage(Number):The max returned collections per page (default to 30).
sort(String):Specify the ORDER BY fields. Add - / + (default) in front of the attribute for DESC /
ASC order, e.g.: // DESC by created and ASC by id
?sort=-created,id Supported collection sort fields: @random, id, created,
updated, name, type,
system
filter(String):Filter expression to filter/search the returned collections list, e.g.: ?filter=(name~'abc' && created>'2022-01-01') Supported collection filter fields: id, created, updated,
name, type, system The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
skipTotal(Boolean):If it is set the total counts query will be skipped and the response fields
totalItems and totalPages will have -1 value.
This could drastically speed up the search queries when the total counters are not needed or cursor based
pagination is used.
For optimization purposes, it is set by default for the
getFirstListItem()
and
getFullList() SDKs methods.
collectionIdOrName(String):ID or name of the collection to view.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
collectionIdOrName(String):ID or name of the collection to view.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
collectionIdOrName(String):ID or name of the collection to view.
collectionIdOrName(String):ID or name of the collection to truncate.
Required collections(Array<Collection>):List of collections to import (replace and create).
Optional deleteMissing(Boolean):If true all existing collections and schema fields that are not present in the
imported configuration will be deleted, including their related records
data (default to
false).
# Web APIs reference - API Collections
- **page** (Number): The page (aka. offset) of the paginated list (default to 1).
- **perPage** (Number): The max returned collections per page (default to 30).
- **sort** (String): Specify the ORDER BY fields. Add - / + (default) in front of the attribute for DESC /
ASC order, e.g.: // DESC by created and ASC by id
?sort=-created,id Supported collection sort fields: @random, id, created,
updated, name, type,
system
- **filter** (String): Filter expression to filter/search the returned collections list, e.g.: ?filter=(name~'abc' && created>'2022-01-01') Supported collection filter fields: id, created, updated,
name, type, system The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **skipTotal** (Boolean): If it is set the total counts query will be skipped and the response fields
totalItems and totalPages will have -1 value.
This could drastically speed up the search queries when the total counters are not needed or cursor based
pagination is used.
For optimization purposes, it is set by default for the
getFirstListItem()
and
getFullList() SDKs methods.
- **collectionIdOrName** (String): ID or name of the collection to view.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the collection to view.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the collection to view.
- **collectionIdOrName** (String): ID or name of the collection to truncate.
- **Required collections** (Array<Collection>): List of collections to import (replace and create).
- **Optional deleteMissing** (Boolean): If true all existing collections and schema fields that are not present in the
imported configuration will be deleted, including their related records
data (default to
false).
API Collections    List collections    Returns a paginated Collections list.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// fetch a paginated collections list
const pageResult = await pb.collections.getList(1, 100, {
filter: 'created >= "2022-01-01 00:00:00"',
// you can also fetch all collections at once via getFullList
const collections = await pb.collections.getFullList({ sort: '-created' });
// or fetch only the first collection that matches the specified filter
const collection = await pb.collections.getFirstListItem('type="auth"');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// fetch a paginated collections list
final pageResult = await pb.collections.getList(
page: 1,
perPage: 100,
filter: 'created >= "2022-01-01 00:00:00"',
// you can also fetch all collections at once via getFullList
final collections = await pb.collections.getFullList(sort: '-created');
// or fetch only the first collection that matches the specified filter
final collection = await pb.collections.getFirstListItem('type="auth"');   ###### API details
GET /api/collections Requires `Authorization:TOKEN` Query parameters Param Type Description page Number The page (aka. offset) of the paginated list (default to 1). perPage Number The max returned collections per page (default to 30). sort String Specify the ORDER BY fields.
Add - / + (default) in front of the attribute for DESC /
ASC order, e.g.:
// DESC by created and ASC by id
?sort=-created,id  Supported collection sort fields:  @random, id, created,
updated, name, type,
system
filter String Filter expression to filter/search the returned collections list, e.g.:
`?filter=(name~'abc' &amp;&amp; created>'2022-01-01')`  Supported collection filter fields:  id, created, updated,
name, type, system
The syntax basically follows the format
OPERAND OPERATOR OPERAND, where:
-OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false
-OPERATOR - is one of:
= Equal
-!= NOT equal
-> Greater than
->= Greater than or equal
-&lt; Less than
-&lt;= Less than or equal
-~ Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-!~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
-?= Any/At least one of Equal
-?!= Any/At least one of NOT equal
-?> Any/At least one of Greater than
-?>= Any/At least one of Greater than or equal
-?&lt; Any/At least one of Less than
-?&lt;= Any/At least one of Less than or equal
-?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
To group and combine several expressions you can use parenthesis
(...), &amp;&amp; (AND) and || (OR) tokens.
Single line comments are also supported: // Example comment.
fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
skipTotal Boolean If it is set the total counts query will be skipped and the response fields
`totalItems` and `totalPages` will have `-1` value.
This could drastically speed up the search queries when the total counters are not needed or cursor based
pagination is used.
For optimization purposes, it is set by default for the
`getFirstListItem()`
and
`getFullList()` SDKs methods. Responses  {
"page": 1,
"perPage": 2,
"totalItems": 10,
"totalPages": 5,
"items": [
"id": "_pbc_344172009",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "users",
"type": "auth",
"fields": [
"autogeneratePattern": "[a-z0-9]{15}",
"hidden": false,
"id": "text3208210256",
"max": 15,
"min": 15,
"name": "id",
"pattern": "^[a-z0-9]+$",
"presentable": false,
"primaryKey": true,
"required": true,
"system": true,
"type": "text"
"cost": 0,
"hidden": true,
"id": "password901924565",
"max": 0,
"min": 8,
"name": "password",
"pattern": "",
"presentable": false,
"required": true,
"system": true,
"type": "password"
"autogeneratePattern": "[a-zA-Z0-9]{50}",
"hidden": true,
"id": "text2504183744",
"max": 60,
"min": 30,
"name": "tokenKey",
"pattern": "",
"presentable": false,
"primaryKey": false,
"required": true,
"system": true,
"type": "text"
"exceptDomains": null,
"hidden": false,
"id": "email3885137012",
"name": "email",
"onlyDomains": null,
"presentable": false,
"required": true,
"system": true,
"type": "email"
"hidden": false,
"id": "bool1547992806",
"name": "emailVisibility",
"presentable": false,
"required": false,
"system": true,
"type": "bool"
"hidden": false,
"id": "bool256245529",
"name": "verified",
"presentable": false,
"required": false,
"system": true,
"type": "bool"
"autogeneratePattern": "",
"hidden": false,
"id": "text1579384326",
"max": 255,
"min": 0,
"name": "name",
"pattern": "",
"presentable": false,
"primaryKey": false,
"required": false,
"system": false,
"type": "text"
"hidden": false,
"id": "file376926767",
"maxSelect": 1,
"maxSize": 0,
"mimeTypes": [
"image/jpeg",
"image/png",
"image/svg+xml",
"image/gif",
"image/webp"
"name": "avatar",
"presentable": false,
"protected": false,
"required": false,
"system": false,
"thumbs": null,
"type": "file"
"hidden": false,
"id": "autodate2990389176",
"name": "created",
"onCreate": true,
"onUpdate": false,
"presentable": false,
"system": false,
"type": "autodate"
"hidden": false,
"id": "autodate3332085495",
"name": "updated",
"onCreate": true,
"onUpdate": true,
"presentable": false,
"system": false,
"type": "autodate"
"indexes": [
"CREATE UNIQUE INDEX `idx_tokenKey__pbc_344172009` ON `users` (`tokenKey`)",
"CREATE UNIQUE INDEX `idx_email__pbc_344172009` ON `users` (`email`) WHERE `email` != ''"
"system": false,
"authRule": "",
"manageRule": null,
"authAlert": {
"enabled": true,
"emailTemplate": {
"subject": "Login from a new location",
"body": "..."
"oauth2": {
"enabled": false,
"mappedFields": {
"id": "",
"name": "name",
"username": "",
"avatarURL": "avatar"
"providers": [
"pkce": null,
"name": "google",
"clientId": "abc",
"authURL": "",
"tokenURL": "",
"userInfoURL": "",
"displayName": "",
"extra": null
"passwordAuth": {
"enabled": true,
"identityFields": [
"email"
"mfa": {
"enabled": false,
"duration": 1800,
"rule": ""
"otp": {
"enabled": false,
"duration": 180,
"length": 8,
"emailTemplate": {
"subject": "OTP for {APP_NAME}",
"body": "..."
"authToken": {
"duration": 604800
"passwordResetToken": {
"duration": 1800
"emailChangeToken": {
"duration": 1800
"verificationToken": {
"duration": 259200
"fileToken": {
"duration": 180
"verificationTemplate": {
"subject": "Verify your {APP_NAME} email",
"body": "..."
"resetPasswordTemplate": {
"subject": "Reset your {APP_NAME} password",
"body": "..."
"confirmEmailChangeTemplate": {
"subject": "Confirm your {APP_NAME} new email address",
"body": "..."
"id": "_pbc_2287844090",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "posts",
"type": "base",
"fields": [
"autogeneratePattern": "[a-z0-9]{15}",
"hidden": false,
"id": "text3208210256",
"max": 15,
"min": 15,
"name": "id",
"pattern": "^[a-z0-9]+$",
"presentable": false,
"primaryKey": true,
"required": true,
"system": true,
"type": "text"
"autogeneratePattern": "",
"hidden": false,
"id": "text724990059",
"max": 0,
"min": 0,
"name": "title",
"pattern": "",
"presentable": false,
"primaryKey": false,
"required": false,
"system": false,
"type": "text"
"hidden": false,
"id": "autodate2990389176",
"name": "created",
"onCreate": true,
"onUpdate": false,
"presentable": false,
"system": false,
"type": "autodate"
"hidden": false,
"id": "autodate3332085495",
"name": "updated",
"onCreate": true,
"onUpdate": true,
"presentable": false,
"system": false,
"type": "autodate"
"indexes": [],
"system": false
}  {
"status": 400,
"message": "Something went wrong while processing your request. Invalid filter.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "Only superusers can perform this action.",
"data": {}
}      View collection    Returns a single Collection by its ID or name.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const collection = await pb.collections.getOne('demo');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final collection = await pb.collections.getOne('demo');   ###### API details
GET /api/collections/`collectionIdOrName` Requires `Authorization:TOKEN` Path parameters Param Type Description collectionIdOrName String ID or name of the collection to view. Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"id": "_pbc_2287844090",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "posts",
"type": "base",
"fields": [
"autogeneratePattern": "[a-z0-9]{15}",
"hidden": false,
"id": "text3208210256",
"max": 15,
"min": 15,
"name": "id",
"pattern": "^[a-z0-9]+$",
"presentable": false,
"primaryKey": true,
"required": true,
"system": true,
"type": "text"
"autogeneratePattern": "",
"hidden": false,
"id": "text724990059",
"max": 0,
"min": 0,
"name": "title",
"pattern": "",
"presentable": false,
"primaryKey": false,
"required": false,
"system": false,
"type": "text"
"hidden": false,
"id": "autodate2990389176",
"name": "created",
"onCreate": true,
"onUpdate": false,
"presentable": false,
"system": false,
"type": "autodate"
"hidden": false,
"id": "autodate3332085495",
"name": "updated",
"onCreate": true,
"onUpdate": true,
"presentable": false,
"system": false,
"type": "autodate"
"indexes": [],
"system": false
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}
}      Create collection    Creates a new Collection.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// create base collection
const base = await pb.collections.create({
name: 'exampleBase',
type: 'base',
fields: [
name: 'title',
type: 'text',
required: true,
min: 10,
name: 'status',
type: 'bool',
// create auth collection
const auth = await pb.collections.create({
name: 'exampleAuth',
type: 'auth',
createRule: 'id = @request.auth.id',
updateRule: 'id = @request.auth.id',
deleteRule: 'id = @request.auth.id',
fields: [
name: 'name',
type: 'text',
passwordAuth: {
enabled: true,
identityFields: ['email']
// create view collection
const view = await pb.collections.create({
name: 'exampleView',
type: 'view',
listRule: '@request.auth.id != ""',
viewRule: null,
// the schema will be autogenerated from the below query
viewQuery: 'SELECT id, name from posts',
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// create base collection
final base = await pb.collections.create(body: {
'name': 'exampleBase',
'type': 'base',
'fields': [
'name': 'title',
'type': 'text',
'required': true,
'min': 10,
'name': 'status',
'type': 'bool',
// create auth collection
final auth = await pb.collections.create(body: {
'name': 'exampleAuth',
'type': 'auth',
'createRule': 'id = @request.auth.id',
'updateRule': 'id = @request.auth.id',
'deleteRule': 'id = @request.auth.id',
'fields': [
'name': 'name',
'type': 'text',
'passwordAuth': {
'enabled': true,
'identityFields': ['email']
// create view collection
final view = await pb.collections.create(body: {
'name': 'exampleView',
'type': 'view',
'listRule': '@request.auth.id != ""',
'viewRule': null,
// the schema will be autogenerated from the below query
'viewQuery': 'SELECT id, name from posts',
});   ###### API details
POST /api/collections Requires `Authorization:TOKEN` Body Parameters Body parameters could be sent as JSON or multipart/form-data.
// 15 characters string to store as collection ID.
// If not set, it will be auto generated.
id (optional): string
// Unique collection name (used as a table name for the records table).
name (required):  string
// Type of the collection.
// If not set, the collection type will be "base" by default.
type (optional): "base" | "view" | "auth"
// List with the collection fields.
// This field is optional and autopopulated for "view" collections based on the viewQuery.
fields (required|optional): Array&lt;Field>
// The collection indexes and unique constraints.
// Note that "view" collections don't support indexes.
indexes (optional): Array&lt;string>
// Marks the collection as "system" to prevent being renamed, deleted or modify its API rules.
system (optional): boolean
// CRUD API rules
listRule (optional):   null|string
viewRule (optional):   null|string
createRule (optional): null|string
updateRule (optional): null|string
deleteRule (optional): null|string
// view options
viewQuery (required):  string
// auth options
// API rule that gives admin-like permissions to allow fully managing the auth record(s),
// e.g. changing the password without requiring to enter the old one, directly updating the
// verified state or email, etc. This rule is executed in addition to the createRule and updateRule.
manageRule (optional): null|string
// API rule that could be used to specify additional record constraints applied after record
// authentication and right before returning the auth token response to the client.
// For example, to allow only verified users you could set it to "verified = true".
// Set it to empty string to allow any Auth collection record to authenticate.
// Set it to null to disallow authentication altogether for the collection.
authRule (optional): null|string
// AuthAlert defines options related to the auth alerts on new device login.
authAlert (optional): {
enabled (optional): boolean
emailTemplate (optional): {
subject (required): string
body (required):    string
// OAuth2 specifies whether OAuth2 auth is enabled for the collection
// and which OAuth2 providers are allowed.
oauth2 (optional): {
enabled (optional): boolean
mappedFields (optional): {
id (optional):        string
name (optional):      string
username (optional):  string
avatarURL (optional): string
providers (optional): [
name (required):         string
clientId (required):     string
clientSecret (required): string
authUrl (optional):      string
tokenUrl (optional):     string
userApiUrl (optional):   string
displayName (optional):  string
pkce (optional):         null|boolean
// PasswordAuth defines options related to the collection password authentication.
passwordAuth (optional): {
enabled (optional):        boolean
identityFields (required): Array&lt;string>
// MFA defines options related to the Multi-factor authentication (MFA).
mfa (optional):{
enabled (optional):  boolean
duration (required): number
rule (optional):     string
// OTP defines options related to the One-time password authentication (OTP).
otp (optional): {
enabled (optional):  boolean
duration (required): number
length (required):   number
emailTemplate (optional): {
subject (required): string
body (required):    string
// Token configurations.
authToken (optional): {
duration (required): number
secret (required):   string
passwordResetToken (optional): {
duration (required): number
secret (required):   string
emailChangeToken (optional): {
duration (required): number
secret (required):   string
verificationToken (optional): {
duration (required): number
secret (required):   string
fileToken (optional): {
duration (required): number
secret (required):   string
// Default email templates.
verificationTemplate (optional): {
subject (required): string
body (required):    string
resetPasswordTemplate (optional): {
subject (required): string
body (required):    string
confirmEmailChangeTemplate (optional): {
subject (required): string
body (required):    string
}  Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"id": "_pbc_2287844090",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "posts",
"type": "base",
"fields": [
"autogeneratePattern": "[a-z0-9]{15}",
"hidden": false,
"id": "text3208210256",
"max": 15,
"min": 15,
"name": "id",
"pattern": "^[a-z0-9]+$",
"presentable": false,
"primaryKey": true,
"required": true,
"system": true,
"type": "text"
"autogeneratePattern": "",
"hidden": false,
"id": "text724990059",
"max": 0,
"min": 0,
"name": "title",
"pattern": "",
"presentable": false,
"primaryKey": false,
"required": false,
"system": false,
"type": "text"
"hidden": false,
"id": "autodate2990389176",
"name": "created",
"onCreate": true,
"onUpdate": false,
"presentable": false,
"system": false,
"type": "autodate"
"hidden": false,
"id": "autodate3332085495",
"name": "updated",
"onCreate": true,
"onUpdate": true,
"presentable": false,
"system": false,
"type": "autodate"
"indexes": [],
"system": false
}  {
"status": 400,
"message": "An error occurred while submitting the form.",
"data": {
"title": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Update collection    Updates a single Collection by its ID or name.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const collection = await pb.collections.update('demo', {
name: 'new_demo',
listRule: 'created > "2022-01-01 00:00:00"',
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final collection = await pb.collections.update('demo', body: {
'name': 'new_demo',
'listRule': 'created > "2022-01-01 00:00:00"',
});   ###### API details
PATCH /api/collections/`collectionIdOrName` Requires `Authorization:TOKEN` Path parameters Param Type Description collectionIdOrName String ID or name of the collection to view. Body Parameters Body parameters could be sent as JSON or multipart/form-data.
// Unique collection name (used as a table name for the records table).
name (required):  string
// List with the collection fields.
// This field is optional and autopopulated for "view" collections based on the viewQuery.
fields (required|optional): Array&lt;Field>
// The collection indexes and unique constriants.
// Note that "view" collections don't support indexes.
indexes (optional): Array&lt;string>
// Marks the collection as "system" to prevent being renamed, deleted or modify its API rules.
system (optional): boolean
// CRUD API rules
listRule (optional):   null|string
viewRule (optional):   null|string
createRule (optional): null|string
updateRule (optional): null|string
deleteRule (optional): null|string
// view options
viewQuery (required):  string
// auth options
// API rule that gives admin-like permissions to allow fully managing the auth record(s),
// e.g. changing the password without requiring to enter the old one, directly updating the
// verified state or email, etc. This rule is executed in addition to the createRule and updateRule.
manageRule (optional): null|string
// API rule that could be used to specify additional record constraints applied after record
// authentication and right before returning the auth token response to the client.
// For example, to allow only verified users you could set it to "verified = true".
// Set it to empty string to allow any Auth collection record to authenticate.
// Set it to null to disallow authentication altogether for the collection.
authRule (optional): null|string
// AuthAlert defines options related to the auth alerts on new device login.
authAlert (optional): {
enabled (optional): boolean
emailTemplate (optional): {
subject (required): string
body (required):    string
// OAuth2 specifies whether OAuth2 auth is enabled for the collection
// and which OAuth2 providers are allowed.
oauth2 (optional): {
enabled (optional): boolean
mappedFields (optional): {
id (optional):        string
name (optional):      string
username (optional):  string
avatarURL (optional): string
providers (optional): [
name (required):         string
clientId (required):     string
clientSecret (required): string
authUrl (optional):      string
tokenUrl (optional):     string
userApiUrl (optional):   string
displayName (optional):  string
pkce (optional):         null|boolean
// PasswordAuth defines options related to the collection password authentication.
passwordAuth (optional): {
enabled (optional):        boolean
identityFields (required): Array&lt;string>
// MFA defines options related to the Multi-factor authentication (MFA).
mfa (optional):{
enabled (optional):  boolean
duration (required): number
rule (optional):     string
// OTP defines options related to the One-time password authentication (OTP).
otp (optional): {
enabled (optional):  boolean
duration (required): number
length (required):   number
emailTemplate (optional): {
subject (required): string
body (required):    string
// Token configurations.
authToken (optional): {
duration (required): number
secret (required):   string
passwordResetToken (optional): {
duration (required): number
secret (required):   string
emailChangeToken (optional): {
duration (required): number
secret (required):   string
verificationToken (optional): {
duration (required): number
secret (required):   string
fileToken (optional): {
duration (required): number
secret (required):   string
// Default email templates.
verificationTemplate (optional): {
subject (required): string
body (required):    string
resetPasswordTemplate (optional): {
subject (required): string
body (required):    string
confirmEmailChangeTemplate (optional): {
subject (required): string
body (required):    string
}  Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"id": "_pbc_2287844090",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "posts",
"type": "base",
"fields": [
"autogeneratePattern": "[a-z0-9]{15}",
"hidden": false,
"id": "text3208210256",
"max": 15,
"min": 15,
"name": "id",
"pattern": "^[a-z0-9]+$",
"presentable": false,
"primaryKey": true,
"required": true,
"system": true,
"type": "text"
"autogeneratePattern": "",
"hidden": false,
"id": "text724990059",
"max": 0,
"min": 0,
"name": "title",
"pattern": "",
"presentable": false,
"primaryKey": false,
"required": false,
"system": false,
"type": "text"
"hidden": false,
"id": "autodate2990389176",
"name": "created",
"onCreate": true,
"onUpdate": false,
"presentable": false,
"system": false,
"type": "autodate"
"hidden": false,
"id": "autodate3332085495",
"name": "updated",
"onCreate": true,
"onUpdate": true,
"presentable": false,
"system": false,
"type": "autodate"
"indexes": [],
"system": false
}  {
"status": 400,
"message": "An error occurred while submitting the form.",
"data": {
"email": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Delete collection    Deletes a single Collection by its ID or name.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.collections.delete('demo');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.collections.delete('demo');   ###### API details
DELETE /api/collections/`collectionIdOrName` Requires `Authorization:TOKEN` Path parameters Param Type Description collectionIdOrName String ID or name of the collection to view. Responses  `null`  {
"status": 400,
"message": "Failed to delete collection. Make sure that the collection is not referenced by other collections.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}
}      Truncate collection    Deletes all the records of a single collection (including their related files and cascade delete
enabled relations).
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.collections.truncate('demo');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.collections.truncate('demo');   ###### API details
DELETE /api/collections/`collectionIdOrName`/truncate Requires `Authorization:TOKEN` Path parameters Param Type Description collectionIdOrName String ID or name of the collection to truncate. Responses  `null`  {
"status": 400,
"message": "Failed to truncate collection (most likely due to required cascade delete record references).",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}
}      Import collections    Bulk imports the provided Collections configuration.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const importData = [
name: 'collection1',
schema: [
name: 'status',
type: 'bool',
name: 'collection2',
schema: [
name: 'title',
type: 'text',
await pb.collections.import(importData, false);  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final importData = [
CollectionModel(
name: "collection1",
schema: [
SchemaField(name: "status", type: "bool"),
CollectionModel(
name: "collection2",
schema: [
SchemaField(name: "title", type: "text"),
await pb.collections.import(importData, deleteMissing: false);   ###### API details
PUT /api/collections/import Requires `Authorization:TOKEN` Body Parameters Param Type Description Required collections Array&lt;Collection> List of collections to import (replace and create). Optional deleteMissing Boolean If true all existing collections and schema fields that are not present in the
imported configuration will be deleted, including their related records
data (default to
false). Body parameters could be sent as JSON or
multipart/form-data. Responses  `null`  {
"status": 400,
"message": "An error occurred while submitting the form.",
"data": {
"collections": {
"code": "collections_import_failure",
"message": "Failed to import the collections configuration."
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Scaffolds    Returns an object will all of the collection types and their default fields
(used primarily in the Dashboard UI).
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const scaffolds = await pb.collections.getScaffolds();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final scaffolds = await pb.collections.getScaffolds();   ###### API details
GET /api/collections/meta/scaffolds Requires `Authorization:TOKEN` Responses  {
"auth": {
"id": "",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "",
"type": "auth",
"fields": [
"autogeneratePattern": "[a-z0-9]{15}",
"hidden": false,
"id": "text3208210256",
"max": 15,
"min": 15,
"name": "id",
"pattern": "^[a-z0-9]+$",
"presentable": false,
"primaryKey": true,
"required": true,
"system": true,
"type": "text"
"cost": 0,
"hidden": true,
"id": "password901924565",
"max": 0,
"min": 8,
"name": "password",
"pattern": "",
"presentable": false,
"required": true,
"system": true,
"type": "password"
"autogeneratePattern": "[a-zA-Z0-9]{50}",
"hidden": true,
"id": "text2504183744",
"max": 60,
"min": 30,
"name": "tokenKey",
"pattern": "",
"presentable": false,
"primaryKey": false,
"required": true,
"system": true,
"type": "text"
"exceptDomains": null,
"hidden": false,
"id": "email3885137012",
"name": "email",
"onlyDomains": null,
"presentable": false,
"required": true,
"system": true,
"type": "email"
"hidden": false,
"id": "bool1547992806",
"name": "emailVisibility",
"presentable": false,
"required": false,
"system": true,
"type": "bool"
"hidden": false,
"id": "bool256245529",
"name": "verified",
"presentable": false,
"required": false,
"system": true,
"type": "bool"
"indexes": [
"CREATE UNIQUE INDEX `idx_tokenKey_hclGvwhtqG` ON `test` (`tokenKey`)",
"CREATE UNIQUE INDEX `idx_email_eyxYyd3gp1` ON `test` (`email`) WHERE `email` != ''"
"created": "",
"updated": "",
"system": false,
"authRule": "",
"manageRule": null,
"authAlert": {
"enabled": true,
"emailTemplate": {
"subject": "Login from a new location",
"body": "..."
"oauth2": {
"providers": [],
"mappedFields": {
"id": "",
"name": "",
"username": "",
"avatarURL": ""
"enabled": false
"passwordAuth": {
"enabled": true,
"identityFields": [
"email"
"mfa": {
"enabled": false,
"duration": 1800,
"rule": ""
"otp": {
"enabled": false,
"duration": 180,
"length": 8,
"emailTemplate": {
"subject": "OTP for {APP_NAME}",
"body": "..."
"authToken": {
"duration": 604800
"passwordResetToken": {
"duration": 1800
"emailChangeToken": {
"duration": 1800
"verificationToken": {
"duration": 259200
"fileToken": {
"duration": 180
"verificationTemplate": {
"subject": "Verify your {APP_NAME} email",
"body": "..."
"resetPasswordTemplate": {
"subject": "Reset your {APP_NAME} password",
"body": "..."
"confirmEmailChangeTemplate": {
"subject": "Confirm your {APP_NAME} new email address",
"body": "..."
"base": {
"id": "",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "",
"type": "base",
"fields": [
"autogeneratePattern": "[a-z0-9]{15}",
"hidden": false,
"id": "text3208210256",
"max": 15,
"min": 15,
"name": "id",
"pattern": "^[a-z0-9]+$",
"presentable": false,
"primaryKey": true,
"required": true,
"system": true,
"type": "text"
"indexes": [],
"created": "",
"updated": "",
"system": false
"view": {
"id": "",
"listRule": null,
"viewRule": null,
"createRule": null,
"updateRule": null,
"deleteRule": null,
"name": "",
"type": "view",
"fields": [],
"indexes": [],
"created": "",
"updated": "",
"system": false,
"viewQuery": ""
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}

## 17.Web APIs reference - API Records
POST /api/collections/{collection}/records
collectionIdOrName(String):ID or name of the records' collection.
page(Number):The page (aka. offset) of the paginated list (default to 1).
perPage(Number):The max returned records per page (default to 30).
sort(String):Specify the ORDER BY fields. Add - / + (default) in front of the attribute for DESC /
ASC order, eg.: // DESC by created and ASC by id
?sort=-created,id Supported record sort fields: @random, @rowid, id,
and any other collection field.
filter(String):Filter expression to filter/search the returned records list (in addition to the
collection's listRule), e.g.: ?filter=(title~'abc' && created>'2022-01-01') Supported record filter fields: id, + any field from the collection schema. The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
skipTotal(Boolean):If it is set the total counts query will be skipped and the response fields
totalItems and totalPages will have -1 value.
This could drastically speed up the search queries when the total counters are not needed or cursor based
pagination is used.
For optimization purposes, it is set by default for the
getFirstListItem()
and
getFullList() SDKs methods.
collectionIdOrName(String):ID or name of the record's collection.
recordId(String):ID of the record to view.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
collectionIdOrName(String):ID or name of the record's collection.
Optional id(String):15 characters string to store as record ID.
If not set, it will be auto generated.
Required password(String):Auth record password.
Required passwordConfirm(String):Auth record password confirmation.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
collectionIdOrName(String):ID or name of the record's collection.
recordId(String):ID of the record to update.
Optional oldPassword*(String):Old auth record password.
This field is required only when changing the record password. Superusers and auth records
with "Manage" access can skip this field.
Optional password(String):New auth record password.
Optional passwordConfirm(String):New auth record password confirmation.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
collectionIdOrName(String):ID or name of the record's collection.
recordId(String):ID of the record to delete.
Required requests(Array<Request> - List of the requests to process.
The supported batch request actions are: record create - POST /api/collections/{collection}/records record update -
PATCH /api/collections/{collection}/records/{id} record upsert - PUT /api/collections/{collection}/records (the body must have id field) record delete -
DELETE /api/collections/{collection}/records/{id} Each batch Request element have the following properties: url path (could include query parameters) method (GET, POST, PUT, PATCH, DELETE) headers (custom per-request Authorization header is not supported at the moment,
aka. all batch requests have the same auth state) body NB! When the batch request is send as
multipart/form-data, the regular batch action fields are expected to be
submitted as serialized json under the @jsonPayload field and file keys
need to follow the pattern requests.N.fileField or
requests[N].fileField (this is usually handled transparently by the SDKs when their specific object
notation is used)
If you don't use the SDKs or prefer manually to construct the FormData
body, then it could look something like:
const formData = new FormData();
formData.append("@jsonPayload", JSON.stringify({
requests: [
method: "POST",
url: "/api/collections/example/records?expand=user",
body: { title: "test1" },
},
method: "PATCH",
url: "/api/collections/example/records/RECORD_ID",
body: { title: "test2" },
},
method: "DELETE",
url: "/api/collections/example/records/RECORD_ID",
},
}))
// file for the first request
formData.append("requests.0.document", new File(...))
// file for the second request
formData.append("requests.1.document", new File(...))):
collectionIdOrName(String):ID or name of the auth collection.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
collectionIdOrName(String):ID or name of the auth collection.
Required identity(String):Auth record username or email address.
Required password(String):Auth record password.
Optional identityField(String):A specific identity field to use (by default fallbacks to the first matching one).
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
collectionIdOrName(String):ID or name of the auth collection.
Required provider(String):The name of the OAuth2 client provider (e.g. "google").
Required code(String):The authorization code returned from the initial request.
Required codeVerifier(String):The code verifier sent with the initial request as part of the code_challenge.
Required redirectUrl(String):The redirect url sent with the initial request.
Optional createData(Object):Optional data that will be used when creating the auth record on OAuth2 sign-up. The created auth record must comply with the same requirements and validations in the
regular create action.
The data can only be in json, aka. multipart/form-data and
files upload currently are not supported during OAuth2 sign-ups.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
collectionIdOrName(String):ID or name of the auth collection.
Required email(String):The auth record email address to send the OTP request (if exists).
collectionIdOrName(String):ID or name of the auth collection.
Required otpId(String):The id of the OTP request.
Required password(String):The one-time password.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
collectionIdOrName(String):ID or name of the auth collection.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
Required email(String):The auth record email address to send the verification request (if exists).
Required token(String):The token from the verification request email.
Required email(String):The auth record email address to send the password reset request (if exists).
Required token(String):The token from the password reset request email.
Required password(String):The new password to set.
Required passwordConfirm(String):The new password confirmation.
Required newEmail(String):The new email address to send the change email request.
Required token(String):The token from the change email request email.
Required password(String):The account password to confirm the email change.
collectionIdOrName(String):ID or name of the auth collection.
id(String):ID of the auth record to impersonate.
Optional duration(Number):Optional custom JWT duration for the exp claim (in seconds).
If not set or 0, it fallbacks to the default collection auth token duration option.
expand(String):Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
# Web APIs reference - API Records
`POST /api/collections/{collection}/records`
- **collectionIdOrName** (String): ID or name of the records' collection.
- **page** (Number): The page (aka. offset) of the paginated list (default to 1).
- **perPage** (Number): The max returned records per page (default to 30).
- **sort** (String): Specify the ORDER BY fields. Add - / + (default) in front of the attribute for DESC /
ASC order, eg.: // DESC by created and ASC by id
?sort=-created,id Supported record sort fields: @random, @rowid, id,
and any other collection field.
- **filter** (String): Filter expression to filter/search the returned records list (in addition to the
collection's listRule), e.g.: ?filter=(title~'abc' && created>'2022-01-01') Supported record filter fields: id, + any field from the collection schema. The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **skipTotal** (Boolean): If it is set the total counts query will be skipped and the response fields
totalItems and totalPages will have -1 value.
This could drastically speed up the search queries when the total counters are not needed or cursor based
pagination is used.
For optimization purposes, it is set by default for the
getFirstListItem()
and
getFullList() SDKs methods.
- **collectionIdOrName** (String): ID or name of the record's collection.
- **recordId** (String): ID of the record to view.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the record's collection.
- **Optional id** (String): 15 characters string to store as record ID.
If not set, it will be auto generated.
- **Required password** (String): Auth record password.
- **Required passwordConfirm** (String): Auth record password confirmation.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the record's collection.
- **recordId** (String): ID of the record to update.
- **Optional oldPassword** (String) (required): Old auth record password.
This field is required only when changing the record password. Superusers and auth records
with "Manage" access can skip this field.
- **Optional password** (String): New auth record password.
- **Optional passwordConfirm** (String): New auth record password confirmation.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the record's collection.
- **recordId** (String): ID of the record to delete.
- **Required requests** (Array<Request> - List of the requests to process.
The supported batch request actions are: record create - POST /api/collections/{collection}/records record update -
PATCH /api/collections/{collection}/records/{id} record upsert - PUT /api/collections/{collection}/records (the body must have id field) record delete -
DELETE /api/collections/{collection}/records/{id} Each batch Request element have the following properties: url path (could include query parameters) method (GET, POST, PUT, PATCH, DELETE) headers (custom per-request Authorization header is not supported at the moment,
aka. all batch requests have the same auth state) body NB! When the batch request is send as
multipart/form-data, the regular batch action fields are expected to be
submitted as serialized json under the @jsonPayload field and file keys
need to follow the pattern requests.N.fileField or
requests[N].fileField (this is usually handled transparently by the SDKs when their specific object
notation is used)
If you don't use the SDKs or prefer manually to construct the FormData
body, then it could look something like:
const formData = new FormData();
formData.append("@jsonPayload", JSON.stringify({
requests: [
method: "POST",
url: "/api/collections/example/records?expand=user",
body: { title: "test1" },
method: "PATCH",
url: "/api/collections/example/records/RECORD_ID",
body: { title: "test2" },
method: "DELETE",
url: "/api/collections/example/records/RECORD_ID",
}))
// file for the first request
formData.append("requests.0.document", new File(...))
// file for the second request
formData.append("requests.1.document", new File(...))):
- **collectionIdOrName** (String): ID or name of the auth collection.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the auth collection.
- **Required identity** (String): Auth record username or email address.
- **Required password** (String): Auth record password.
- **Optional identityField** (String): A specific identity field to use (by default fallbacks to the first matching one).
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the auth collection.
- **Required provider** (String): The name of the OAuth2 client provider (e.g. "google").
- **Required code** (String): The authorization code returned from the initial request.
- **Required codeVerifier** (String): The code verifier sent with the initial request as part of the code_challenge.
- **Required redirectUrl** (String): The redirect url sent with the initial request.
- **Optional createData** (Object): Optional data that will be used when creating the auth record on OAuth2 sign-up. The created auth record must comply with the same requirements and validations in the
regular create action.
The data can only be in json, aka. multipart/form-data and
files upload currently are not supported during OAuth2 sign-ups.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the auth collection.
- **Required email** (String): The auth record email address to send the OTP request (if exists).
- **collectionIdOrName** (String): ID or name of the auth collection.
- **Required otpId** (String): The id of the OTP request.
- **Required password** (String): The one-time password.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
- **collectionIdOrName** (String): ID or name of the auth collection.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
- **Required email** (String): The auth record email address to send the verification request (if exists).
- **Required token** (String): The token from the verification request email.
- **Required email** (String): The auth record email address to send the password reset request (if exists).
- **Required token** (String): The token from the password reset request email.
- **Required password** (String): The new password to set.
- **Required passwordConfirm** (String): The new password confirmation.
- **Required newEmail** (String): The new email address to send the change email request.
- **Required token** (String): The token from the change email request email.
- **Required password** (String): The account password to confirm the email change.
- **collectionIdOrName** (String): ID or name of the auth collection.
- **id** (String): ID of the auth record to impersonate.
- **Optional duration** (Number): Optional custom JWT duration for the exp claim (in seconds).
If not set or 0, it fallbacks to the default collection auth token duration option.
- **expand** (String): Auto expand record relations. Ex.:
?expand=relField1,relField2.subRelField
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
expand property (e.g. "expand": {"relField1": {...}, ...}).
Only the relations to which the request user has permissions to view will be expanded.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
API Records ### CRUD actions
List/Search records    Returns a paginated records list, supporting sorting and filtering.
Depending on the collection&#39;s listRule value, the access to this action may or may not
have been restricted.
You could find individual generated records API documentation in the &quot;Dashboard &gt; Collections
&gt; API Preview&quot;.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// fetch a paginated records list
const resultList = await pb.collection('posts').getList(1, 50, {
filter: 'created >= "2022-01-01 00:00:00" &amp;&amp; someField1 != someField2',
// you can also fetch all records at once via getFullList
const records = await pb.collection('posts').getFullList({
sort: '-created',
// or fetch only the first record that matches the specified filter
const record = await pb.collection('posts').getFirstListItem('someField="test"', {
expand: 'relField1,relField2.subRelField',
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// fetch a paginated records list
final resultList = await pb.collection('posts').getList(
page: 1,
perPage: 50,
filter: 'created >= "2022-01-01 00:00:00" &amp;&amp; someField1 != someField2',
// you can also fetch all records at once via getFullList
final records = await pb.collection('posts').getFullList(sort: '-created');
// or fetch only the first record that matches the specified filter
final record = await pb.collection('posts').getFirstListItem(
'someField="test"',
expand: 'relField1,relField2.subRelField',
);   ###### API details
GET /api/collections/`collectionIdOrName`/records Path parameters Param Type Description collectionIdOrName String ID or name of the records&#39; collection. Query parameters Param Type Description page Number The page (aka. offset) of the paginated list (default to 1). perPage Number The max returned records per page (default to 30). sort String Specify the ORDER BY fields.
Add - / + (default) in front of the attribute for DESC /
ASC order, eg.:
// DESC by created and ASC by id
?sort=-created,id  Supported record sort fields:  @random, @rowid, id,
and any other collection field.
filter String Filter expression to filter/search the returned records list (in addition to the
collection&#39;s listRule), e.g.:
`?filter=(title~'abc' &amp;&amp; created>'2022-01-01')`  Supported record filter fields:  id, + any field from the collection schema.
The syntax basically follows the format
OPERAND OPERATOR OPERAND, where:
-OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false
-OPERATOR - is one of:
= Equal
-!= NOT equal
-> Greater than
->= Greater than or equal
-&lt; Less than
-&lt;= Less than or equal
-~ Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-!~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
-?= Any/At least one of Equal
-?!= Any/At least one of NOT equal
-?> Any/At least one of Greater than
-?>= Any/At least one of Greater than or equal
-?&lt; Any/At least one of Less than
-?&lt;= Any/At least one of Less than or equal
-?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
To group and combine several expressions you can use parenthesis
(...), &amp;&amp; (AND) and || (OR) tokens.
Single line comments are also supported: // Example comment.
expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
skipTotal Boolean If it is set the total counts query will be skipped and the response fields
`totalItems` and `totalPages` will have `-1` value.
This could drastically speed up the search queries when the total counters are not needed or cursor based
pagination is used.
For optimization purposes, it is set by default for the
`getFirstListItem()`
and
`getFullList()` SDKs methods. Responses  {
"page": 1,
"perPage": 100,
"totalItems": 2,
"totalPages": 1,
"items": [
"id": "ae40239d2bc4477",
"collectionId": "a98f514eb05f454",
"collectionName": "posts",
"updated": "2022-06-25 11:03:50.052",
"created": "2022-06-25 11:03:35.163",
"title": "test1"
"id": "d08dfc4f4d84419",
"collectionId": "a98f514eb05f454",
"collectionName": "posts",
"updated": "2022-06-25 11:03:45.876",
"created": "2022-06-25 11:03:45.876",
"title": "test2"
}  {
"status": 400,
"message": "Something went wrong while processing your request. Invalid filter.",
"data": {}
}  {
"status": 403,
"message": "Only superusers can filter by '@collection.*'",
"data": {}
}      View record    Returns a single collection record by its ID.
Depending on the collection&#39;s viewRule value, the access to this action may or may not
have been restricted.
You could find individual generated records API documentation in the &quot;Dashboard &gt; Collections
&gt; API Preview&quot;.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const record1 = await pb.collection('posts').getOne('RECORD_ID', {
expand: 'relField1,relField2.subRelField',
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final record1 = await pb.collection('posts').getOne('RECORD_ID',
expand: 'relField1,relField2.subRelField',
);   ###### API details
GET /api/collections/`collectionIdOrName`/records/`recordId` Path parameters Param Type Description collectionIdOrName String ID or name of the record&#39;s collection. recordId String ID of the record to view. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"id": "ae40239d2bc4477",
"collectionId": "a98f514eb05f454",
"collectionName": "posts",
"updated": "2022-06-25 11:03:50.052",
"created": "2022-06-25 11:03:35.163",
"title": "test1"
}  {
"status": 403,
"message": "Only superusers can perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}
}      Create record    Creates a new collection Record.
Depending on the collection&#39;s createRule value, the access to this action may or may not
have been restricted.
You could find individual generated records API documentation from the Dashboard.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const record = await pb.collection('demo').create({
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final record = await pb.collection('demo').create(body: {
});   ###### API details
POST /api/collections/`collectionIdOrName`/records Path parameters Param Type Description collectionIdOrName String ID or name of the record&#39;s collection. Body Parameters Param Type Description Optional id String 15 characters string to store as record ID.
If not set, it will be auto generated. Schema fields Any field from the collection&#39;s schema. Additional auth record fields Required password String Auth record password. Required passwordConfirm String Auth record password confirmation. Body parameters could be sent as JSON or
multipart/form-data.
File upload is supported only through multipart/form-data. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"collectionId": "a98f514eb05f454",
"collectionName": "demo",
"id": "ae40239d2bc4477",
"updated": "2022-06-25 11:03:50.052",
"created": "2022-06-25 11:03:35.163",
}  {
"status": 400,
"message": "Failed to create record.",
"data": {
"title": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 403,
"message": "Only superusers can perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found. Missing collection context.",
"data": {}
}      Update record    Updates an existing collection Record.
Depending on the collection&#39;s updateRule value, the access to this action may or may not
have been restricted.
You could find individual generated records API documentation from the Dashboard.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const record = await pb.collection('demo').update('YOUR_RECORD_ID', {
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final record = await pb.collection('demo').update('YOUR_RECORD_ID', body: {
});   ###### API details
PATCH /api/collections/`collectionIdOrName`/records/`recordId` Path parameters Param Type Description collectionIdOrName String ID or name of the record&#39;s collection. recordId String ID of the record to update. Body Parameters Param Type Description Schema fields Any field from the collection&#39;s schema. Additional auth record fields Optional oldPassword String Old auth record password.
This field is required only when changing the record password. Superusers and auth records
with &quot;Manage&quot; access can skip this field. Optional password String New auth record password. Optional passwordConfirm String New auth record password confirmation. Body parameters could be sent as JSON or
multipart/form-data.
File upload is supported only through multipart/form-data. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"collectionId": "a98f514eb05f454",
"collectionName": "demo",
"id": "ae40239d2bc4477",
"updated": "2022-06-25 11:03:50.052",
"created": "2022-06-25 11:03:35.163",
}  {
"status": 400,
"message": "Failed to create record.",
"data": {
"title": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 403,
"message": "Only superusers can perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found. Missing collection context.",
"data": {}
}      Delete record    Deletes a single collection Record by its ID.
Depending on the collection&#39;s deleteRule value, the access to this action may or may not
have been restricted.
You could find individual generated records API documentation from the Dashboard.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.collection('demo').delete('YOUR_RECORD_ID');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.collection('demo').delete('YOUR_RECORD_ID');   ###### API details
DELETE /api/collections/`collectionIdOrName`/records/`recordId` Path parameters Param Type Description collectionIdOrName String ID or name of the record&#39;s collection. recordId String ID of the record to delete. Responses  `null`  {
"status": 400,
"message": "Failed to delete record. Make sure that the record is not part of a required relation reference.",
"data": {}
}  {
"status": 403,
"message": "Only superusers can perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}
}      Batch create/update/upsert/delete records    Batch and transactional create/update/upsert/delete of multiple records in a single request.
The batch Web API need to be explicitly enabled and configured from the
Dashboard &gt; Settings &gt; Application.
Because this endpoint processes the requests in a single read&amp;write transaction, other queries
may queue up and it could degrade the performance of your application if not used with proper
care and configuration
(some recommendations: prefer using the smallest possible max processing time and body
size limits; avoid large file uploads over slow S3 networks and custom hooks that
communicate with slow external APIs).
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const batch = pb.createBatch();
batch.collection('example1').create({ ... });
batch.collection('example2').update('RECORD_ID', { ... });
batch.collection('example3').delete('RECORD_ID');
batch.collection('example4').upsert({ ... });
const result = await batch.send();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final batch = pb.createBatch();
batch.collection('example1').create(body: { ... });
batch.collection('example2').update('RECORD_ID', body: { ... });
batch.collection('example3').delete('RECORD_ID');
batch.collection('example4').upsert(body: { ... });
final result = await batch.send();   ###### API details
POST /api/batch Body Parameters Body parameters could be sent as application/json or multipart/form-data.
File upload is supported only via multipart/form-data (see below for more details).
Param Description Required requests Array&lt;Request> - List of the requests to process.
The supported batch request actions are:
-record create - POST /api/collections/{collection}/records
-record update -
PATCH /api/collections/{collection}/records/{id}
-record upsert - PUT /api/collections/{collection}/records  (the body must have id field)
-record delete -
DELETE /api/collections/{collection}/records/{id}
Each batch Request element have the following properties:
-url path (could include query parameters)
-method (GET, POST, PUT, PATCH, DELETE)
-headers  (custom per-request Authorization header is not supported at the moment,
aka. all batch requests have the same auth state)
-body
NB! When the batch request is send as
multipart/form-data, the regular batch action fields are expected to be
submitted as serialized json under the @jsonPayload field and file keys
need to follow the pattern requests.N.fileField or
requests[N].fileField (this is usually handled transparently by the SDKs when their specific object
notation is used)
If you don&#39;t use the SDKs or prefer manually to construct the FormData
body, then it could look something like:
const formData = new FormData();
formData.append("@jsonPayload", JSON.stringify({
requests: [
method: "POST",
url: "/api/collections/example/records?expand=user",
body: { title: "test1" },
method: "PATCH",
url: "/api/collections/example/records/RECORD_ID",
body: { title: "test2" },
method: "DELETE",
url: "/api/collections/example/records/RECORD_ID",
// file for the first request
formData.append("requests.0.document", new File(...))
// file for the second request
formData.append("requests.1.document", new File(...))
Responses  [
"status": 200,
"body": {
"collectionId": "a98f514eb05f454",
"collectionName": "demo",
"id": "ae40239d2bc4477",
"updated": "2022-06-25 11:03:50.052",
"created": "2022-06-25 11:03:35.163",
"title": "test1",
"document": "file_a98f51.txt"
"status": 200,
"body": {
"collectionId": "a98f514eb05f454",
"collectionName": "demo",
"id": "31y1gc447bc9602",
"updated": "2022-06-25 11:03:50.052",
"created": "2022-06-25 11:03:35.163",
"title": "test2",
"document": "file_f514eb0.txt"
]  {
"status": 400,
"message": "Batch transaction failed.",
"data": {
"requests": {
"1": {
"code": "batch_request_failed",
"message": "Batch request failed.",
"response": {
"status": 400,
"message": "Failed to create record.",
"data": {
"title": {
"code": "validation_min_text_constraint",
"message": "Must be at least 3 character(s).",
"params": { "min": 3 }
}  {
"status": 403,
"message": "Batch requests are not allowed.",
"data": {}
}   ### Auth record actions
List auth methods    Returns a public list with the allowed collection authentication methods.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const result = await pb.collection('users').listAuthMethods();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final result = await pb.collection('users').listAuthMethods();   ###### API details
GET /api/collections/`collectionIdOrName`/auth-methods Path parameters Param Type Description collectionIdOrName String ID or name of the auth collection. Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"password": {
"enabled": true,
"identityFields": ["email"]
"oauth2": {
"enabled": true,
"providers": [
"name": "github",
"displayName": "GitHub",
"state": "nT7SLxzXKAVMeRQJtxSYj9kvnJAvGk",
"authURL": "https://github.com/login/oauth/authorize?client_id=test&amp;code_challenge=fcf8WAhNI6uCLJYgJubLyWXHvfs8xghoLe3zksBvxjE&amp;code_challenge_method=S256&amp;response_type=code&amp;scope=read%3Auser+user%3Aemail&amp;state=nT7SLxzXKAVMeRQJtxSYj9kvnJAvGk&amp;redirect_uri=",
"codeVerifier": "PwBG5OKR2IyQ7siLrrcgWHFwLLLAeUrz7PS1nY4AneG",
"codeChallenge": "fcf8WAhNI6uCLJYgJubLyWXHvfs8xghoLe3zksBvxjE",
"codeChallengeMethod": "S256"
"mfa": {
"enabled": false,
"duration": 0
"otp": {
"enabled": false,
"duration": 0
}      Auth with password    Authenticate a single auth record by combination of a password and a unique identity field (e.g.
email).
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const authData = await pb.collection('users').authWithPassword(
'YOUR_USERNAME_OR_EMAIL',
'YOUR_PASSWORD',
// after the above you can also access the auth data from the authStore
console.log(pb.authStore.isValid);
console.log(pb.authStore.token);
console.log(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final authData = await pb.collection('users').authWithPassword(
'YOUR_USERNAME_OR_EMAIL',
'YOUR_PASSWORD',
// after the above you can also access the auth data from the authStore
print(pb.authStore.isValid);
print(pb.authStore.token);
print(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();   ###### API details
POST /api/collections/`collectionIdOrName`/auth-with-password Path parameters Param Type Description collectionIdOrName String ID or name of the auth collection. Body Parameters Param Type Description Required identity String Auth record username or email address. Required password String Auth record password. Optional identityField String A specific identity field to use (by default fallbacks to the first matching one). Body parameters could be sent as JSON or
multipart/form-data. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
Responses  {
"token": "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoUmVjb3JkIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyMjA4OTg1MjYxfQ.UwD8JvkbQtXpymT09d7J6fdA0aP9g4FJ1GPh_ggEkzc",
"record": {
"id": "8171022dc95a4ed",
"collectionId": "d2972397d45614e",
"collectionName": "users",
"created": "2022-06-24 06:24:18.434Z",
"updated": "2022-06-24 06:24:18.889Z",
"verified": false,
"emailVisibility": true,
"someCustomField": "example 123"
}  {
"status": 400,
"message": "An error occurred while submitting the form.",
"data": {
"password": {
"code": "validation_required",
"message": "Missing required value."
}      Auth with OAuth2    Authenticate with an OAuth2 provider and returns a new auth token and record data.
This action usually should be called right after the provider login page redirect.
You could also check the
OAuth2 web integration example.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const authData = await pb.collection('users').authWithOAuth2Code(
'google',
'CODE',
'VERIFIER',
'REDIRECT_URL',
// optional data that will be used for the new account on OAuth2 sign-up
'name': 'test',
// after the above you can also access the auth data from the authStore
console.log(pb.authStore.isValid);
console.log(pb.authStore.token);
console.log(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final authData = await pb.collection('users').authWithOAuth2Code(
'google',
'CODE',
'VERIFIER',
'REDIRECT_URL',
// optional data that will be used for the new account on OAuth2 sign-up
createData: {
'name': 'test',
// after the above you can also access the auth data from the authStore
print(pb.authStore.isValid);
print(pb.authStore.token);
print(pb.authStore.record.id);
// "logout" the last authenticated record
pb.authStore.clear();   ###### API details
POST /api/collections/`collectionIdOrName`/auth-with-oauth2 Path parameters Param Type Description collectionIdOrName String ID or name of the auth collection. Body Parameters Param Type Description Required provider String The name of the OAuth2 client provider (e.g. &quot;google&quot;). Required code String The authorization code returned from the initial request. Required codeVerifier String The code verifier sent with the initial request as part of the code_challenge. Required redirectUrl String The redirect url sent with the initial request. Optional createData Object Optional data that will be used when creating the auth record on OAuth2 sign-up.
The created auth record must comply with the same requirements and validations in the
regular create action.
The data can only be in json, aka. multipart/form-data and
files upload currently are not supported during OAuth2 sign-ups.
Body parameters could be sent as JSON or
multipart/form-data. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
Responses  {
"token": "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoUmVjb3JkIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyMjA4OTg1MjYxfQ.UwD8JvkbQtXpymT09d7J6fdA0aP9g4FJ1GPh_ggEkzc",
"record": {
"id": "8171022dc95a4ed",
"collectionId": "d2972397d45614e",
"collectionName": "users",
"created": "2022-06-24 06:24:18.434Z",
"updated": "2022-06-24 06:24:18.889Z",
"verified": true,
"emailVisibility": false,
"someCustomField": "example 123"
"meta": {
"id": "abc123",
"name": "John Doe",
"username": "john.doe",
"isNew": false,
"accessToken": "...",
"refreshToken": "...",
"expiry": "..."
}  {
"status": 400,
"message": "An error occurred while submitting the form.",
"data": {
"provider": {
"code": "validation_required",
"message": "Missing required value."
}      Auth with OTP    Authenticate a single auth record with an one-time password (OTP).
Note that when requesting an OTP we return an otpId even if a user with the provided email
doesn&#39;t exist as a very basic enumeration protection.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// send OTP email to the provided auth record
// ... show a screen/popup to enter the password from the email ...
// authenticate with the requested OTP id and the email password
const authData = await pb.collection('users').authWithOTP(req.otpId, "YOUR_OTP");
// after the above you can also access the auth data from the authStore
console.log(pb.authStore.isValid);
console.log(pb.authStore.token);
console.log(pb.authStore.record.id);
// "logout"
pb.authStore.clear();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// send OTP email to the provided auth record
// ... show a screen/popup to enter the password from the email ...
// authenticate with the requested OTP id and the email password
final authData = await pb.collection('users').authWithOTP(req.otpId, "YOUR_OTP");
// after the above you can also access the auth data from the authStore
print(pb.authStore.isValid);
print(pb.authStore.token);
print(pb.authStore.record.id);
// "logout"
pb.authStore.clear();   ###### API details
OTP Auth  POST /api/collections/`collectionIdOrName`/request-otp Path parameters Param Type Description collectionIdOrName String ID or name of the auth collection. Body Parameters Param Type Description Required email String The auth record email address to send the OTP request (if exists). Responses  {
"otpId": "frJOeqFIiPIbaYT"
}  {
"status": 400,
"message": "An error occurred while validating the submitted data.",
"data": {
"email": {
"code": "validation_is_email",
"message": "Must be a valid email address."
}  {
"status": 429,
"message": "You've send too many OTP requests, please try again later.",
"data": {}
}   POST /api/collections/`collectionIdOrName`/auth-with-otp Path parameters Param Type Description collectionIdOrName String ID or name of the auth collection. Body Parameters Param Type Description Required otpId String The id of the OTP request. Required password String The one-time password. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
Responses  {
"token": "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoUmVjb3JkIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyMjA4OTg1MjYxfQ.UwD8JvkbQtXpymT09d7J6fdA0aP9g4FJ1GPh_ggEkzc",
"record": {
"id": "8171022dc95a4ed",
"collectionId": "d2972397d45614e",
"collectionName": "users",
"created": "2022-06-24 06:24:18.434Z",
"updated": "2022-06-24 06:24:18.889Z",
"verified": false,
"emailVisibility": true,
"someCustomField": "example 123"
}  {
"status": 400,
"message": "Failed to authenticate.",
"data": {
"otpId": {
"code": "validation_required",
"message": "Missing required value."
}       Auth refresh    Returns a new auth response (token and user data) for already authenticated auth record.
stored data in pb.authStore is still valid and up-to-date.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const authData = await pb.collection('users').authRefresh();
// after the above you can also access the refreshed auth data from the authStore
console.log(pb.authStore.isValid);
console.log(pb.authStore.token);
console.log(pb.authStore.record.id);  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final authData = await pb.collection('users').authRefresh();
// after the above you can also access the refreshed auth data from the authStore
print(pb.authStore.isValid);
print(pb.authStore.token);
print(pb.authStore.record.id);   ###### API details
POST /api/collections/`collectionIdOrName`/auth-refresh Requires `Authorization:TOKEN` Path parameters Param Type Description collectionIdOrName String ID or name of the auth collection. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
Responses  {
"token": "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoUmVjb3JkIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyMjA4OTg1MjYxfQ.UwD8JvkbQtXpymT09d7J6fdA0aP9g4FJ1GPh_ggEkzc",
"record": {
"id": "8171022dc95a4ed",
"collectionId": "d2972397d45614e",
"collectionName": "users",
"created": "2022-06-24 06:24:18.434Z",
"updated": "2022-06-24 06:24:18.889Z",
"verified": false,
"emailVisibility": true,
"someCustomField": "example 123"
}  {
"status": 401,
"message": "The request requires valid record authorization token to be set.",
"data": {}
}  {
"status": 403,
"message": "The authorized record model is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "Missing auth record context.",
"data": {}
}      Verification    Sends auth record email verification request.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// (optional) in your custom confirmation page:
await pb.collection('users').confirmVerification('VERIFICATION_TOKEN');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// (optional) in your custom confirmation page:
await pb.collection('users').confirmVerification('VERIFICATION_TOKEN');   ###### API details
Confirm verification  POST /api/collections/`collectionIdOrName`/request-verification Body Parameters Param Type Description Required email String The auth record email address to send the verification request (if exists). Responses  `null`  {
"status": 400,
"message": "An error occurred while validating the submitted data.",
"data": {
"email": {
"code": "validation_required",
"message": "Missing required value."
}   POST /api/collections/`collectionIdOrName`/confirm-verification Body Parameters Param Type Description Required token String The token from the verification request email. Responses  `null`  {
"status": 400,
"message": "An error occurred while validating the submitted data.",
"data": {
"token": {
"code": "validation_required",
"message": "Missing required value."
}       Password reset    Sends auth record password reset email request.
automatically invalidated.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// (optional) in your custom confirmation page:
await pb.collection('users').confirmPasswordReset(
'RESET_TOKEN',
'NEW_PASSWORD',
'NEW_PASSWORD_CONFIRM',
);  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// (optional) in your custom confirmation page:
await pb.collection('users').confirmPasswordReset(
'RESET_TOKEN',
'NEW_PASSWORD',
'NEW_PASSWORD_CONFIRM',
);   ###### API details
Confirm password reset  POST /api/collections/`collectionIdOrName`/request-password-reset Body Parameters Param Type Description Required email String The auth record email address to send the password reset request (if exists). Responses  `null`  {
"status": 400,
"message": "An error occurred while validating the submitted data.",
"data": {
"email": {
"code": "validation_required",
"message": "Missing required value."
}   POST /api/collections/`collectionIdOrName`/confirm-password-reset Body Parameters Param Type Description Required token String The token from the password reset request email. Required password String The new password to set. Required passwordConfirm String The new password confirmation. Responses  `null`  {
"status": 400,
"message": "An error occurred while validating the submitted data.",
"data": {
"token": {
"code": "validation_required",
"message": "Missing required value."
}       Email change    Sends auth record email change request.
automatically invalidated.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// (optional) in your custom confirmation page:
await pb.collection('users').confirmEmailChange('EMAIL_CHANGE_TOKEN', 'YOUR_PASSWORD');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// (optional) in your custom confirmation page:
await pb.collection('users').confirmEmailChange('EMAIL_CHANGE_TOKEN', 'YOUR_PASSWORD');   ###### API details
Confirm email change  POST /api/collections/`collectionIdOrName`/request-email-change Requires Authorization:TOKEN
Body Parameters Param Type Description Required newEmail String The new email address to send the change email request. Responses  `null`  {
"status": 400,
"message": "An error occurred while validating the submitted data.",
"data": {
"newEmail": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 401,
"message": "The request requires valid record authorization token to be set.",
"data": {}
}  {
"status": 403,
"message": "The authorized record model is not allowed to perform this action.",
"data": {}
}   POST /api/collections/`collectionIdOrName`/confirm-email-change Body Parameters Param Type Description Required token String The token from the change email request email. Required password String The account password to confirm the email change. Responses  `null`  {
"status": 400,
"message": "An error occurred while validating the submitted data.",
"data": {
"token": {
"code": "validation_required",
"message": "Missing required value."
}       Impersonate    Impersonate allows you to authenticate as a different user by generating a
nonrefreshable auth token.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// authenticate as superuser
// impersonate
// (the custom token duration is optional and must be in seconds)
const impersonateClient = pb.collection("users").impersonate("USER_RECORD_ID", 3600)
// log the impersonate token and user data
console.log(impersonateClient.authStore.token);
console.log(impersonateClient.authStore.record);
// send requests as the impersonated user
impersonateClient.collection("example").getFullList();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// authenticate as superuser
// impersonate
// (the custom token duration is optional and must be in seconds)
final impersonateClient = pb.collection("users").impersonate("USER_RECORD_ID", 3600)
// log the impersonate token and user data
print(impersonateClient.authStore.token);
print(impersonateClient.authStore.record);
// send requests as the impersonated user
impersonateClient.collection("example").getFullList();   ###### API details
POST /api/collections/`collectionIdOrName`/impersonate/`id` Requires `Authorization:TOKEN` Path parameters Param Type Description collectionIdOrName String ID or name of the auth collection. id String ID of the auth record to impersonate. Body Parameters Param Type Description Optional duration Number Optional custom JWT duration for the `exp` claim (in seconds).
If not set or 0, it fallbacks to the default collection auth token duration option. Body parameters could be sent as JSON or
multipart/form-data. Query parameters Param Type Description expand String Auto expand record relations. Ex.:
`?expand=relField1,relField2.subRelField`
Supports up to 6-levels depth nested relations expansion.
The expanded relations will be appended to the record under the
`expand` property (e.g. `"expand": {"relField1": {...}, ...}`).
Only the relations to which the request user has permissions to view will be expanded. fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,record.expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,record.description:excerpt(200,true)
Responses  {
"token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJjb2xsZWN0aW9uSWQiOiJfcGJjX2MwcHdrZXNjcXMiLCJleHAiOjE3MzAzNjgxMTUsImlkIjoicXkwMmMxdDBueDBvanFuIiwicmVmcmVzaGFibGUiOmZhbHNlLCJ0eXBlIjoiYXV0aCJ9.1JOaE54TyPdDLf0mb0T6roIYeh8Y1HfJvDlYZADMN4U",
"record": {
"id": "8171022dc95a4ed",
"collectionId": "d2972397d45614e",
"collectionName": "users",
"created": "2022-06-24 06:24:18.434Z",
"updated": "2022-06-24 06:24:18.889Z",
"verified": false,
"emailVisibility": true,
"someCustomField": "example 123"
}  {
"status": 400,
"message": "The request requires valid record authorization token to be set.",
"data": {
"duration": {
"code": "validation_min_greater_equal_than_required",
"message": "Must be no less than 0."
}  {
"status": 401,
"message": "An error occurred while validating the submitted data.",
"data": {}
}  {
"status": 403,
"message": "The authorized record model is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}

## 18.Web APIs reference - API Realtime
Required clientId(String):ID of the SSE client connection.
Optional subscriptions(Array<String>):The new client subscriptions to set in the format:
COLLECTION_ID_OR_NAME or
COLLECTION_ID_OR_NAME/RECORD_ID. You can also attach optional query and header parameters as serialized json to a
single topic using the options
query parameter, e.g.:
COLLECTION_ID_OR_NAME/RECORD_ID?options={"query": {"abc": "123"}, "headers": {"x-token": "..."}} Leave empty to unsubscribe from everything.
# Web APIs reference - API Realtime
- **Required clientId** (String): ID of the SSE client connection.
- **Optional subscriptions** (Array<String>): The new client subscriptions to set in the format:
COLLECTION_ID_OR_NAME or
COLLECTION_ID_OR_NAME/RECORD_ID. You can also attach optional query and header parameters as serialized json to a
single topic using the options
query parameter, e.g.:
COLLECTION_ID_OR_NAME/RECORD_ID?options={"query": {"abc": "123"}, "headers": {"x-token": "..."}} Leave empty to unsubscribe from everything.
API Realtime The Realtime API is implemented via Server-Sent Events (SSE). Generally, it consists of 2 operations:
-establish SSE connection
-submit client subscriptions
SSE events are sent for create, update
and delete record operations.
You could subscribe to a single record or to an entire collection.
When you subscribe to a single record, the collection&#39;s
ViewRule will be used to determine whether the subscriber has access to receive the
event message.
When you subscribe to an entire collection, the collection&#39;s
ListRule will be used to determine whether the subscriber has access to receive the
event message.
Connect    GET /api/realtime Establishes a new SSE connection and immediately sends a PB_CONNECT SSE event with the
created client ID.
NB! The user/superuser authorization happens during the first
Set subscriptions
call.
If the connected client doesn&#39;t receive any new messages for 5 minutes, the server will send a
disconnect signal (this is to prevent forgotten/leaked connections). The connection will be
automatically reestablished if the client is still active (e.g. the browser tab is still open).
If Authorization header is set, will authorize the client SSE connection with the
associated user or superuser.
Body Parameters Param Type Description Required clientId String ID of the SSE client connection. Optional subscriptions Array&lt;String> The new client subscriptions to set in the format:
COLLECTION_ID_OR_NAME or
COLLECTION_ID_OR_NAME/RECORD_ID.
You can also attach optional query and header parameters as serialized json to a
single topic using the options
query parameter, e.g.:
COLLECTION_ID_OR_NAME/RECORD_ID?options={"query": {"abc": "123"}, "headers": {"x-token": "..."}}
Leave empty to unsubscribe from everything.
Body parameters could be sent as JSON or
multipart/form-data. Responses  `null`  {
"status": 400,
"message": "Something went wrong while processing your request.",
"data": {
"clientId": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 403,
"data": {}
}  {
"status": 404,
"message": "Missing or invalid client id.",
"data": {}
}   All of this is seamlessly handled by the SDKs using just the subscribe and
unsubscribe methods:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
// (Optionally) authenticate
// Subscribe to changes in any record in the collection
pb.collection('example').subscribe('*', function (e) {
console.log(e.action);
console.log(e.record);
}, { /* other options like expand, custom headers, etc. */ });
// Subscribe to changes only in the specified record
pb.collection('example').subscribe('RECORD_ID', function (e) {
console.log(e.action);
console.log(e.record);
}, { /* other options like expand, custom headers, etc. */ });
// Unsubscribe
pb.collection('example').unsubscribe('RECORD_ID'); // remove all 'RECORD_ID' subscriptions
pb.collection('example').unsubscribe('*'); // remove all '*' topic subscriptions
pb.collection('example').unsubscribe(); // remove all subscriptions in the collection  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
// (Optionally) authenticate
// Subscribe to changes in any record in the collection
pb.collection('example').subscribe('*', (e) {
print(e.action);
print(e.record);
}, /* other options like expand, custom headers, etc. */);
// Subscribe to changes only in the specified record
pb.collection('example').subscribe('RECORD_ID', (e) {
print(e.action);
print(e.record);
}, /* other options like expand, custom headers, etc. */);
// Unsubscribe
pb.collection('example').unsubscribe('RECORD_ID'); // remove all 'RECORD_ID' subscriptions
pb.collection('example').unsubscribe('*'); // remove all '*' topic subscriptions
pb.collection('example').unsubscribe(); // remove all subscriptions in the collection

## 19.Web APIs reference - API Files
collectionIdOrName(String):ID or name of the collection whose record model contains the file resource.
recordId(String):ID of the record model that contains the file resource.
filename(String):Name of the file resource.
thumb(String):Get the thumb of the requested file.
The following thumb formats are currently supported: WxH
(e.g. 100x300) - crop to WxH viewbox (from center) WxHt
(e.g. 100x300t) - crop to WxH viewbox (from top) WxHb
(e.g. 100x300b) - crop to WxH viewbox (from bottom) WxHf
(e.g. 100x300f) - fit inside a WxH viewbox (without cropping) 0xH
(e.g. 0x300) - resize to H height preserving the aspect ratio Wx0
(e.g. 100x0) - resize to W width preserving the aspect ratio
If the thumb size is not defined in the file schema field options or the file resource is not
an image (jpg, png, gif, webp), then the original file resource is returned unmodified.
token(String):Optional file token for granting access to
protected file(s).
For an example, you can check
"Files upload and handling".
download(Boolean):If it is set to a truthy value (1, t, true) the file will be
served with Content-Disposition: attachment header instructing the browser to
ignore the file preview for pdf, images, videos, etc. and to directly download the file.
# Web APIs reference - API Files
- **collectionIdOrName** (String): ID or name of the collection whose record model contains the file resource.
- **recordId** (String): ID of the record model that contains the file resource.
- **filename** (String): Name of the file resource.
- **thumb** (String): Get the thumb of the requested file.
The following thumb formats are currently supported: WxH
(e.g. 100x300) - crop to WxH viewbox (from center) WxHt
(e.g. 100x300t) - crop to WxH viewbox (from top) WxHb
(e.g. 100x300b) - crop to WxH viewbox (from bottom) WxHf
(e.g. 100x300f) - fit inside a WxH viewbox (without cropping) 0xH
(e.g. 0x300) - resize to H height preserving the aspect ratio Wx0
(e.g. 100x0) - resize to W width preserving the aspect ratio
If the thumb size is not defined in the file schema field options or the file resource is not
an image (jpg, png, gif, webp), then the original file resource is returned unmodified.
- **token** (String): Optional file token for granting access to
protected file(s).
For an example, you can check
"Files upload and handling".
served with Content-Disposition: attachment header instructing the browser to
API Files Files are uploaded, updated or deleted via the
Records API.
manipulations, like generating thumbs).
GET  /api/files/`collectionIdOrName`/`recordId`/`filename` Path parameters Param Type Description collectionIdOrName String ID or name of the collection whose record model contains the file resource. recordId String ID of the record model that contains the file resource. filename String Name of the file resource. Query parameters Param Type Description thumb String Get the thumb of the requested file.
The following thumb formats are currently supported:
-WxH
(e.g. 100x300) - crop to WxH viewbox (from center)
-WxHt
(e.g. 100x300t) - crop to WxH viewbox (from top)
-WxHb
(e.g. 100x300b) - crop to WxH viewbox (from bottom)
-WxHf
(e.g. 100x300f) - fit inside a WxH viewbox (without cropping)
-0xH
(e.g. 0x300) - resize to H height preserving the aspect ratio
-Wx0
(e.g. 100x0) - resize to W width preserving the aspect ratio
If the thumb size is not defined in the file schema field options or the file resource is not
an image (jpg, png, gif, webp), then the original file resource is returned unmodified. token String Optional file token for granting access to
protected file(s).
For an example, you can check
served with `Content-Disposition: attachment` header instructing the browser to
"status": 400,
"message": "Filesystem initialization failure.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}
}      Generate protected file token    Generates a short-lived file token for accessing
protected file(s).
The client must be superuser or auth record authenticated (aka. have regular authorization token
sent with the request).
###### API details
POST /api/files/token Requires `Authorization:TOKEN` Responses  {
"token": "..."
}  {
"status": 400,
"message": "Failed to generate file token.",
"data": {}

## 20.Web APIs reference - API Crons
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
jobId(String):The identifier of the cron job to run.
# Web APIs reference - API Crons
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **jobId** (String): The identifier of the cron job to run.
API Crons    List cron jobs    Returns list with all registered app level cron jobs.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const jobs = await pb.crons.getFullList();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final jobs = await pb.crons.getFullList();   ###### API details
GET /api/crons Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  [
"id": "__pbDBOptimize__",
"expression": "0 0 * * *"
"id": "__pbMFACleanup__",
"expression": "0 * * * *"
"id": "__pbOTPCleanup__",
"expression": "0 * * * *"
"id": "__pbLogsCleanup__",
"expression": "0 */6 * * *"
]  {
"status": 400,
"message": "Failed to load backups filesystem.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "Only superusers can perform this action.",
"data": {}
}      Run cron job    Triggers a single cron job by its id.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.crons.run('__pbLogsCleanup__');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.crons.run('__pbLogsCleanup__');   ###### API details
POST /api/crons/`jobId` Requires `Authorization:TOKEN` Path parameters Param Type Description jobId String The identifier of the cron job to run. Responses  `null`  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "Missing or invalid cron job.",
"data": {}

## 21.Web APIs reference - API Settings
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
├─ Required appName(String):The app name.
├─ Required appUrl(String):The app public absolute url.
├─ Optional hideControls(Boolean):Hides the collection create and update controls from the Dashboard.
Useful to prevent making accidental schema changes when in production environment.
├─ Required senderName(String):Transactional mails sender name.
├─ Required senderAddress(String):Transactional mails sender address.
└─ Optional maxDays(Number):Max retention period. Set to 0 for no logs.
└─ Optional minLevel(Number):Specifies the minimum log persistent level.
The default log levels are:
-4: DEBUG 0: INFO 4: WARN 8: ERROR
└─ Optional logIP(Boolean):If enabled includes the client IP in the activity request logs.
└─ Optional logAuthId(Boolean):If enabled includes the authenticated record id in the activity request logs.
├─ Optional cron(String):Cron expression to schedule auto backups, e.g. 0 0 * * *.
├─ Optional cronMaxKeep(Number):The max number of cron generated backups to keep before removing older entries.
└─ Optional s3(Object):S3 configuration (the same fields as for the S3 file storage settings).
├─ Optional enabled(Boolean):Enable the use of the SMTP mail server for sending emails.
├─ Required host*(String):Mail server host (required if SMTP is enabled).
├─ Required port*(Number):Mail server port (required if SMTP is enabled).
├─ Optional username(String):Mail server username.
├─ Optional password(String):Mail server password.
├─ Optional tls(Boolean):Whether to enforce TLS connection encryption.
When false StartTLS command is send, leaving the server to decide whether
to upgrade the connection or not).
├─ Optional authMethod(String):The SMTP AUTH method to use - PLAIN or LOGIN (used mainly by Microsoft).
Default to PLAIN if empty.
└─ Optional localName(String):Optional domain name or (IP address) to use for the initial EHLO/HELO exchange.
If not explicitly set, localhost will be used.
Note that some SMTP providers, such as Gmail SMTP-relay, requires a proper domain name and
and will reject attempts to use localhost.
├─ Optional enabled(Boolean):Enable the use of a S3 compatible storage.
├─ Required bucket*(String):S3 storage bucket (required if enabled).
├─ Required region*(String):S3 storage region (required if enabled).
├─ Required endpoint*(String):S3 storage public endpoint (required if enabled).
├─ Required accessKey*(String):S3 storage access key (required if enabled).
├─ Required secret*(String):S3 storage secret (required if enabled).
└─ Optional forcePathStyle(Boolean):Forces the S3 request to use path-style addressing, e.g.
"https://s3.amazonaws.com/BUCKET/KEY" instead of the default
"https://BUCKET.s3.amazonaws.com/KEY".
├─ Optional enabled(Boolean):Enable the batch Web APIs.
├─ Required maxRequests(Number):The maximum allowed batch request to execute.
├─ Required timeout(Number):The max duration in seconds to wait before cancelling the batch transaction.
└─ Optional maxBodySize(Number):The maximum allowed batch request body size in bytes.
If not set, fallbacks to max ~128MB.
├─ Optional enabled(Boolean):Enable the builtin rate limiter.
└─ Optional rules(Array<RateLimitRule>):List of rate limit rules. Each rule have:
label - the identifier of the rule.
It could be a tag, complete path or path prerefix (when ends with `/`). maxRequests - the max allowed number of requests per duration. duration - specifies the interval (in seconds) per which to reset the
counted/accumulated rate limiter tokens..
├─ Optional headers(Array<String>):List of explicit trusted header(s) to check.
└─ Optional useLeftmostIP(Boolean):Specifies to use the left-mostish IP from the trusted headers.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Required filesystem(String):The storage filesystem to test (storage or backups).
Optional collection(String):The name or id of the auth collection. Fallbacks to _superusers if not set.
Required email(String):The receiver of the test email.
Required template(String):The test email template to send: verification,
password-reset or
email-change.
Required clientId(String):The identifier of your app (aka. Service ID).
Required teamId(String):10-character string associated with your developer account (usually could be found next to
your name in the Apple Developer site).
Required keyId(String):10-character key identifier generated for the "Sign in with Apple" private key associated
with your developer account.
Required privateKey(String):PrivateKey is the private key associated to your app.
Required duration(Number):Duration specifies how long the generated JWT token should be considered valid.
The specified value must be in seconds and max 15777000 (~6months).
# Web APIs reference - API Settings
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **├─ Required appName** (String): The app name.
- **├─ Required appUrl** (String): The app public absolute url.
- **├─ Optional hideControls** (Boolean): Hides the collection create and update controls from the Dashboard.
Useful to prevent making accidental schema changes when in production environment.
- **├─ Required senderName** (String): Transactional mails sender name.
- **├─ Required senderAddress** (String): Transactional mails sender address.
- **└─ Optional maxDays** (Number): Max retention period. Set to 0 for no logs.
- **└─ Optional minLevel** (Number): Specifies the minimum log persistent level.
The default log levels are:
-4: DEBUG 0: INFO 4: WARN 8: ERROR
- **└─ Optional logIP** (Boolean): If enabled includes the client IP in the activity request logs.
- **└─ Optional logAuthId** (Boolean): If enabled includes the authenticated record id in the activity request logs.
- **├─ Optional cron** (String): Cron expression to schedule auto backups, e.g. 0 0 * * *.
- **├─ Optional cronMaxKeep** (Number): The max number of cron generated backups to keep before removing older entries.
- **└─ Optional s3** (Object): S3 configuration (the same fields as for the S3 file storage settings).
- **├─ Optional enabled** (Boolean): Enable the use of the SMTP mail server for sending emails.
- **├─ Required host** (String) (required): Mail server host (required if SMTP is enabled).
- **├─ Required port** (Number) (required): Mail server port (required if SMTP is enabled).
- **├─ Optional username** (String): Mail server username.
- **├─ Optional password** (String): Mail server password.
- **├─ Optional tls** (Boolean): Whether to enforce TLS connection encryption.
When false StartTLS command is send, leaving the server to decide whether
to upgrade the connection or not).
- **├─ Optional authMethod** (String): The SMTP AUTH method to use - PLAIN or LOGIN (used mainly by Microsoft).
Default to PLAIN if empty.
- **└─ Optional localName** (String): Optional domain name or (IP address) to use for the initial EHLO/HELO exchange.
If not explicitly set, localhost will be used.
Note that some SMTP providers, such as Gmail SMTP-relay, requires a proper domain name and
and will reject attempts to use localhost.
- **├─ Optional enabled** (Boolean): Enable the use of a S3 compatible storage.
- **├─ Required bucket** (String) (required): S3 storage bucket (required if enabled).
- **├─ Required region** (String) (required): S3 storage region (required if enabled).
- **├─ Required endpoint** (String) (required): S3 storage public endpoint (required if enabled).
- **├─ Required accessKey** (String) (required): S3 storage access key (required if enabled).
- **├─ Required secret** (String) (required): S3 storage secret (required if enabled).
- **└─ Optional forcePathStyle** (Boolean): Forces the S3 request to use path-style addressing, e.g.
"https://s3.amazonaws.com/BUCKET/KEY" instead of the default
"https://BUCKET.s3.amazonaws.com/KEY".
- **├─ Optional enabled** (Boolean): Enable the batch Web APIs.
- **├─ Required maxRequests** (Number): The maximum allowed batch request to execute.
- **├─ Required timeout** (Number): The max duration in seconds to wait before cancelling the batch transaction.
- **└─ Optional maxBodySize** (Number): The maximum allowed batch request body size in bytes.
If not set, fallbacks to max ~128MB.
- **├─ Optional enabled** (Boolean): Enable the builtin rate limiter.
- **└─ Optional rules** (Array<RateLimitRule>): List of rate limit rules. Each rule have:
label - the identifier of the rule.
It could be a tag, complete path or path prerefix (when ends with `/`). maxRequests - the max allowed number of requests per duration. duration - specifies the interval (in seconds) per which to reset the
counted/accumulated rate limiter tokens..
- **├─ Optional headers** (Array<String>): List of explicit trusted header(s) to check.
- **└─ Optional useLeftmostIP** (Boolean): Specifies to use the left-mostish IP from the trusted headers.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **Required filesystem** (String): The storage filesystem to test (storage or backups).
- **Optional collection** (String): The name or id of the auth collection. Fallbacks to _superusers if not set.
- **Required email** (String): The receiver of the test email.
- **Required template** (String): The test email template to send: verification,
password-reset or
email-change.
- **Required clientId** (String): The identifier of your app (aka. Service ID).
your name in the Apple Developer site).
- **Required keyId** (String): 10-character key identifier generated for the "Sign in with Apple" private key associated
with your developer account.
- **Required privateKey** (String): PrivateKey is the private key associated to your app.
- **Required duration** (Number): Duration specifies how long the generated JWT token should be considered valid.
The specified value must be in seconds and max 15777000 (~6months).
API Settings    List settings    Returns a list with all available application settings.
Secret/password fields are automatically redacted with ****** characters.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const settings = await pb.settings.getAll();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final settings = await pb.settings.getAll();   ###### API details
GET /api/settings Requires `Authorization:TOKEN` Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"smtp": {
"enabled": false,
"port": 587,
"username": "",
"authMethod": "",
"tls": true,
"localName": ""
"backups": {
"cron": "0 0 * * *",
"cronMaxKeep": 3,
"s3": {
"enabled": false,
"bucket": "",
"region": "",
"endpoint": "",
"accessKey": "",
"forcePathStyle": false
"s3": {
"enabled": false,
"bucket": "",
"region": "",
"endpoint": "",
"accessKey": "",
"forcePathStyle": false
"meta": {
"appName": "Acme",
"senderName": "Support",
"hideControls": false
"rateLimits": {
"rules": [
"label": "*:auth",
"audience": "",
"duration": 3,
"maxRequests": 2
"label": "*:create",
"audience": "",
"duration": 5,
"maxRequests": 20
"label": "/api/batch",
"audience": "",
"duration": 1,
"maxRequests": 3
"label": "/api/",
"audience": "",
"duration": 10,
"maxRequests": 300
"enabled": false
"trustedProxy": {
"headers": [],
"useLeftmostIP": false
"batch": {
"enabled": true,
"maxRequests": 50,
"timeout": 3,
"maxBodySize": 0
"logs": {
"maxDays": 7,
"minLevel": 0,
"logIP": true,
"logAuthId": false
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Update settings    Bulk updates application settings and returns the updated settings list.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const settings = await pb.settings.update({
meta: {
appName: 'YOUR_APP',
appUrl: 'http://127.0.0.1:8090',
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final settings = await pb.settings.update(body: {
'meta': {
'appName': 'YOUR_APP',
'appUrl': 'http://127.0.0.1:8090',
});   ###### API details
PATCH /api/settings Requires `Authorization:TOKEN` Body Parameters Param Type Description  meta  Application meta data (name, url, support email, etc.). ├─ Required appName String The app name. ├─ Required appUrl String The app public absolute url. ├─ Optional hideControls Boolean Hides the collection create and update controls from the Dashboard.
Useful to prevent making accidental schema changes when in production environment. ├─ Required senderName String Transactional mails sender name. ├─ Required senderAddress String Transactional mails sender address.  logs  App logger settings. └─ Optional maxDays Number Max retention period. Set to 0 for no logs. └─ Optional minLevel Number Specifies the minimum log persistent level.
The default log levels are:
--4: DEBUG
-0: INFO
-4: WARN
-8: ERROR
└─ Optional logIP Boolean If enabled includes the client IP in the activity request logs. └─ Optional logAuthId Boolean If enabled includes the authenticated record id in the activity request logs.  backups  App data backups settings. ├─ Optional cron String Cron expression to schedule auto backups, e.g. `0 0 * * *`. ├─ Optional cronMaxKeep Number The max number of cron generated backups to keep before removing older entries. └─ Optional s3 Object S3 configuration (the same fields as for the S3 file storage settings).  smtp  SMTP mail server settings. ├─ Optional enabled Boolean Enable the use of the SMTP mail server for sending emails. ├─ Required host String Mail server host (required if SMTP is enabled). ├─ Required port Number Mail server port (required if SMTP is enabled). ├─ Optional username String Mail server username. ├─ Optional password String Mail server password. ├─ Optional tls Boolean Whether to enforce TLS connection encryption.
When false StartTLS command is send, leaving the server to decide whether
to upgrade the connection or not). ├─ Optional authMethod String The SMTP AUTH method to use - PLAIN or LOGIN (used mainly by Microsoft).
Default to PLAIN if empty. └─ Optional localName String Optional domain name or (IP address) to use for the initial EHLO/HELO exchange.
If not explicitly set, `localhost` will be used.
Note that some SMTP providers, such as Gmail SMTP-relay, requires a proper domain name and
and will reject attempts to use localhost.  s3  S3 compatible file storage settings. ├─ Optional enabled Boolean Enable the use of a S3 compatible storage. ├─ Required bucket String S3 storage bucket (required if enabled). ├─ Required region String S3 storage region (required if enabled). ├─ Required endpoint String S3 storage public endpoint (required if enabled). ├─ Required accessKey String S3 storage access key (required if enabled). ├─ Required secret String S3 storage secret (required if enabled). └─ Optional forcePathStyle Boolean Forces the S3 request to use path-style addressing, e.g.
&quot;https://s3.amazonaws.com/BUCKET/KEY&quot; instead of the default
&quot;https://BUCKET.s3.amazonaws.com/KEY&quot;.  batch  Batch logs settings. ├─ Optional enabled Boolean Enable the batch Web APIs. ├─ Required maxRequests Number The maximum allowed batch request to execute. ├─ Required timeout Number The max duration in seconds to wait before cancelling the batch transaction. └─ Optional maxBodySize Number The maximum allowed batch request body size in bytes.
If not set, fallbacks to max ~128MB.  rateLimits  Rate limiter settings. ├─ Optional enabled Boolean Enable the builtin rate limiter. └─ Optional rules Array&lt;RateLimitRule> List of rate limit rules. Each rule have:
-label - the identifier of the rule.
It could be a tag, complete path or path prerefix (when ends with `/`).
-maxRequests - the max allowed number of requests per duration.
-duration - specifies the interval (in seconds) per which to reset the
counted/accumulated rate limiter tokens..
trustedProxy  Trusted proxy headers settings. ├─ Optional headers Array&lt;String> List of explicit trusted header(s) to check. └─ Optional useLeftmostIP Boolean Specifies to use the left-mostish IP from the trusted headers. Body parameters could be sent as JSON or
multipart/form-data. Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"smtp": {
"enabled": false,
"port": 587,
"username": "",
"authMethod": "",
"tls": true,
"localName": ""
"backups": {
"cron": "0 0 * * *",
"cronMaxKeep": 3,
"s3": {
"enabled": false,
"bucket": "",
"region": "",
"endpoint": "",
"accessKey": "",
"forcePathStyle": false
"s3": {
"enabled": false,
"bucket": "",
"region": "",
"endpoint": "",
"accessKey": "",
"forcePathStyle": false
"meta": {
"appName": "Acme",
"senderName": "Support",
"hideControls": false
"rateLimits": {
"rules": [
"label": "*:auth",
"audience": "",
"duration": 3,
"maxRequests": 2
"label": "*:create",
"audience": "",
"duration": 5,
"maxRequests": 20
"label": "/api/batch",
"audience": "",
"duration": 1,
"maxRequests": 3
"label": "/api/",
"audience": "",
"duration": 10,
"maxRequests": 300
"enabled": false
"trustedProxy": {
"headers": [],
"useLeftmostIP": false
"batch": {
"enabled": true,
"maxRequests": 50,
"timeout": 3,
"maxBodySize": 0
"logs": {
"maxDays": 7,
"minLevel": 0,
"logIP": true,
"logAuthId": false
}  {
"status": 400,
"message": "An error occurred while submitting the form.",
"data": {
"meta": {
"appName": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Test S3 storage connection    Performs S3 storage connection test.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.settings.testS3("backups");  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.settings.testS3("backups");   ###### API details
POST /api/settings/test/s3 Requires `Authorization:TOKEN` Body Parameters Param Type Description Required filesystem String The storage filesystem to test (`storage` or `backups`). Body parameters could be sent as JSON or
multipart/form-data. Responses  `null`  {
"status": 400,
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}      Send test email    Sends a test user email.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
final pb = PocketBase('http://127.0.0.1:8090');
POST /api/settings/test/email Requires `Authorization:TOKEN` Body Parameters Param Type Description Optional collection String The name or id of the auth collection. Fallbacks to _superusers if not set. Required email String The receiver of the test email. Required template String The test email template to send:  `verification`,
`password-reset` or
`email-change`. Body parameters could be sent as JSON or
multipart/form-data. Responses  `null`  {
"status": 400,
"message": "Failed to send the test email.",
"data": {
"email": {
"code": "validation_required",
"message": "Missing required value."
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}      Generate Apple client secret    Generates a new Apple OAuth2 client secret key.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.settings.generateAppleClientSecret(clientId, teamId, keyId, privateKey, duration)  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.settings.generateAppleClientSecret(clientId, teamId, keyId, privateKey, duration)   ###### API details
your name in the Apple Developer site). Required keyId String 10-character key identifier generated for the &quot;Sign in with Apple&quot; private key associated
with your developer account. Required privateKey String PrivateKey is the private key associated to your app. Required duration Number Duration specifies how long the generated JWT token should be considered valid.
The specified value must be in seconds and max 15777000 (~6months). Body parameters could be sent as JSON or
multipart/form-data. Responses  {
"secret": "..."
}  {
"status": 400,
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}

## 22.Web APIs reference - API Logs
GET /api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id"
page(Number):The page (aka. offset) of the paginated list (default to 1).
perPage(Number):The max returned logs per page (default to 30).
sort(String):Specify the ORDER BY fields. Add - / + (default) in front of the attribute for DESC /
ASC order, e.g.: // DESC by the insertion rowid and ASC by level
?sort=-rowid,level Supported log sort fields: @random, rowid, id, created,
updated, level, message and any
data.* attribute.
filter(String):Filter expression to filter/search the returned logs list, e.g.: ?filter=(data.url~'test.com' && level>0) Supported log filter fields: id, created, updated,
level, message and any data.* attribute. The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
id(String):ID of the log to view.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
filter(String):Filter expression to filter/search the logs, e.g.: ?filter=(data.url~'test.com' && level>0) Supported log filter fields: rowid, id, created,
updated, level, message and any
data.* attribute. The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
# Web APIs reference - API Logs
`GET /api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id"`
- **page** (Number): The page (aka. offset) of the paginated list (default to 1).
- **perPage** (Number): The max returned logs per page (default to 30).
- **sort** (String): Specify the ORDER BY fields. Add - / + (default) in front of the attribute for DESC /
ASC order, e.g.: // DESC by the insertion rowid and ASC by level
?sort=-rowid,level Supported log sort fields: @random, rowid, id, created,
updated, level, message and any
data.* attribute.
- **filter** (String): Filter expression to filter/search the returned logs list, e.g.: ?filter=(data.url~'test.com' && level>0) Supported log filter fields: id, created, updated,
level, message and any data.* attribute. The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **id** (String): ID of the log to view.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **filter** (String): Filter expression to filter/search the logs, e.g.: ?filter=(data.url~'test.com' && level>0) Supported log filter fields: rowid, id, created,
updated, level, message and any
data.* attribute. The syntax basically follows the format
OPERAND OPERATOR OPERAND, where: OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false OPERATOR - is one of:
= Equal != NOT equal > Greater than >= Greater than or equal < Less than <= Less than or equal ~ Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) !~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) ?= Any/At least one of Equal ?!= Any/At least one of NOT equal ?> Any/At least one of Greater than ?>= Any/At least one of Greater than or equal ?< Any/At least one of Less than ?<= Any/At least one of Less than or equal ?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for wildcard
match) ?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a "%" for
wildcard match) To group and combine several expressions you can use parenthesis
(...), && (AND) and || (OR) tokens. Single line comments are also supported: // Example comment.
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
API Logs    List logs    Returns a paginated logs list.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const pageResult = await pb.logs.getList(1, 20, {
filter: 'data.status >= 400'
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final pageResult = await pb.logs.getList(
page: 1,
perPage: 20,
filter: 'data.status >= 400',
);   ###### API details
GET /api/logs Requires `Authorization:TOKEN` Query parameters Param Type Description page Number The page (aka. offset) of the paginated list (default to 1). perPage Number The max returned logs per page (default to 30). sort String Specify the ORDER BY fields.
Add - / + (default) in front of the attribute for DESC /
ASC order, e.g.:
// DESC by the insertion rowid and ASC by level
?sort=-rowid,level  Supported log sort fields:  @random, rowid, id, created,
updated, level, message and any
data.* attribute.
filter String Filter expression to filter/search the returned logs list, e.g.:
`?filter=(data.url~'test.com' &amp;&amp; level>0)`  Supported log filter fields:  id, created, updated,
level, message and any data.* attribute.
The syntax basically follows the format
OPERAND OPERATOR OPERAND, where:
-OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false
-OPERATOR - is one of:
= Equal
-!= NOT equal
-> Greater than
->= Greater than or equal
-&lt; Less than
-&lt;= Less than or equal
-~ Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-!~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
-?= Any/At least one of Equal
-?!= Any/At least one of NOT equal
-?> Any/At least one of Greater than
-?>= Any/At least one of Greater than or equal
-?&lt; Any/At least one of Less than
-?&lt;= Any/At least one of Less than or equal
-?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
To group and combine several expressions you can use parenthesis
(...), &amp;&amp; (AND) and || (OR) tokens.
Single line comments are also supported: // Example comment.
fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"page": 1,
"perPage": 20,
"totalItems": 2,
"items": [
"id": "ai5z3aoed6809au",
"created": "2024-10-27 09:28:19.524Z",
"data": {
"auth": "_superusers",
"execTime": 2.392327,
"method": "GET",
"remoteIP": "127.0.0.1",
"status": 200,
"type": "request",
"url": "/api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id",
"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
"userIP": "127.0.0.1"
"message": "GET /api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id",
"level": 0
"id": "26apis4s3sm9yqm",
"created": "2024-10-27 09:28:19.524Z",
"data": {
"auth": "_superusers",
"execTime": 2.392327,
"method": "GET",
"remoteIP": "127.0.0.1",
"status": 200,
"type": "request",
"url": "/api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id",
"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
"userIP": "127.0.0.1"
"message": "GET /api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id",
"level": 0
}  {
"status": 400,
"message": "Something went wrong while processing your request. Invalid filter.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      View log    Returns a single log by its ID.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const log = await pb.logs.getOne('LOG_ID');  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final log = await pb.logs.getOne('LOG_ID');   ###### API details
GET /api/logs/`id` Requires `Authorization:TOKEN` Path parameters Param Type Description id String ID of the log to view. Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"id": "ai5z3aoed6809au",
"created": "2024-10-27 09:28:19.524Z",
"data": {
"auth": "_superusers",
"execTime": 2.392327,
"method": "GET",
"remoteIP": "127.0.0.1",
"status": 200,
"type": "request",
"url": "/api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id",
"userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
"userIP": "127.0.0.1"
"message": "GET /api/collections/_pbc_2287844090/records?page=1&amp;perPage=1&amp;filter=&amp;fields=id",
"level": 0
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}
}      Logs statistics    Returns hourly aggregated logs statistics.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const stats = await pb.logs.getStats({
filter: 'data.status >= 400'
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final stats = await pb.logs.getStats(
filter: 'data.status >= 400'
);   ###### API details
GET /api/logs/stats Requires `Authorization:TOKEN` Query parameters Param Type Description filter String Filter expression to filter/search the logs, e.g.:
`?filter=(data.url~'test.com' &amp;&amp; level>0)`  Supported log filter fields:  rowid, id, created,
updated, level, message and any
data.* attribute.
The syntax basically follows the format
OPERAND OPERATOR OPERAND, where:
-OPERAND - could be any field literal, string (single or double quoted),
number, null, true, false
-OPERATOR - is one of:
= Equal
-!= NOT equal
-> Greater than
->= Greater than or equal
-&lt; Less than
-&lt;= Less than or equal
-~ Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-!~ NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
-?= Any/At least one of Equal
-?!= Any/At least one of NOT equal
-?> Any/At least one of Greater than
-?>= Any/At least one of Greater than or equal
-?&lt; Any/At least one of Less than
-?&lt;= Any/At least one of Less than or equal
-?~ Any/At least one of Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for wildcard
match)
-?!~ Any/At least one of NOT Like/Contains (if not specified auto wraps the right string OPERAND in a &quot;%&quot; for
wildcard match)
To group and combine several expressions you can use parenthesis
(...), &amp;&amp; (AND) and || (OR) tokens.
Single line comments are also supported: // Example comment.
fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  [
"total": 4,
"date": "2022-06-01 19:00:00.000"
"total": 1,
"date": "2022-06-02 12:00:00.000"
"total": 8,
"date": "2022-06-02 13:00:00.000"
]  {
"status": 400,
"message": "Something went wrong while processing your request. Invalid filter.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}

## 23.Web APIs reference - API Health
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
# Web APIs reference - API Health
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
API Health    Health check    Returns the health status of the server.
###### API details
GET/HEAD /api/health Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  {
"status": 200,
"message": "API is healthy.",
"data": {
"canBackup": false

## 24.Web APIs reference - API Backups
fields(String):Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Optional name(String):The base name of the backup file to create.
Must be in the format [a-z0-9_-].zip
If not set, it will be auto generated.
Required file(File):The zip archive to upload.
key(String):The key of the backup file to delete.
key(String):The key of the backup file to restore.
key(String):The key of the backup file to download.
token(String):Superuser file token for granting access to the
backup file.
# Web APIs reference - API Backups
- **fields** (String): Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name * targets all keys from the specific depth level. In addition, the following field modifiers are also supported: :excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
- **Optional name** (String): The base name of the backup file to create.
If not set, it will be auto generated.
- **Required file** (File): The zip archive to upload.
- **key** (String): The key of the backup file to delete.
- **key** (String): The key of the backup file to restore.
- **token** (String): Superuser file token for granting access to the
backup file.
API Backups    List backups    Returns list with all available backup files.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const backups = await pb.backups.getFullList();  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
final backups = await pb.backups.getFullList();   ###### API details
GET /api/backups Query parameters Param Type Description fields String Comma separated string of the fields to return in the JSON response
(by default returns all fields). Ex.:
?fields=*,expand.relField.name
* targets all keys from the specific depth level.
In addition, the following field modifiers are also supported:
-:excerpt(maxLength, withEllipsis?)
Returns a short plain text version of the field string value.
Ex.:
?fields=*,description:excerpt(200,true)
Responses  [
"modified": "2023-05-19 16:25:57.542Z",
"size": 251316185
"modified": "2023-05-18 16:25:57.542Z",
"size": 251314010
]  {
"status": 400,
"message": "Failed to load backups filesystem.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "Only superusers can perform this action.",
"data": {}
}      Create backup    Creates a new app data backup.
This action will return an error if there is another backup/restore operation already in progress.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
final pb = PocketBase('http://127.0.0.1:8090');
POST /api/backups Requires `Authorization:TOKEN` Body Parameters Param Type Description Optional name String The base name of the backup file to create.
If not set, it will be auto generated. Body parameters could be sent as JSON or
multipart/form-data. Responses  `null`  {
"status": 400,
"message": "Try again later - another backup/restore process has already been started.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Upload backup    Uploads an existing backup zip file.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.backups.upload({ file: new Blob([...]) });  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.backups.upload(http.MultipartFile.fromBytes('file', ...));   ###### API details
POST /api/backups/upload Requires `Authorization:TOKEN` Body Parameters Param Type Description Required file File The zip archive to upload. Uploading files is supported only via multipart/form-data. Responses  `null`  {
"status": 400,
"message": "Something went wrong while processing your request.",
"data": {
"file": {
"code": "validation_invalid_mime_type",
"message": "\"test_backup.txt\" mime type must be one of: application/zip."
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Delete backup    Deletes a single backup by its name.
This action will return an error if the backup to delete is still being generated or part of a
restore operation.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
final pb = PocketBase('http://127.0.0.1:8090');
DELETE /api/backups/`key` Requires `Authorization:TOKEN` Path parameters Param Type Description key String The key of the backup file to delete. Responses  `null`  {
"status": 400,
"message": "Try again later - another backup/restore process has already been started.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
}      Restore backup    Restore a single backup by its name and restarts the current running PocketBase process.
This action will return an error if there is another backup/restore operation already in progress.
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
final pb = PocketBase('http://127.0.0.1:8090');
POST /api/backups/`key`/restore Requires `Authorization:TOKEN` Path parameters Param Type Description key String The key of the backup file to restore. Responses  `null`  {
"status": 400,
"message": "Try again later - another backup/restore process has already been started.",
"data": {}
}  {
"status": 401,
"message": "The request requires valid record authorization token.",
"data": {}
}  {
"status": 403,
"message": "The authorized record is not allowed to perform this action.",
"data": {}
Only superusers can perform this action.
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
const token = await pb.files.getToken();
final pb = PocketBase('http://127.0.0.1:8090');
final token = await pb.files.getToken();
backup file. Responses  `[file resource]`  {
"status": 400,
"message": "Filesystem initialization failure.",
"data": {}
}  {
"status": 404,
"message": "The requested resource wasn't found.",
"data": {}

## 25.Extend with JavaScript - Overview
# Extend with JavaScript - Overview
Overview  ### JavaScript engine
The prebuilt PocketBase v0.17+ executable comes with embedded ES5 JavaScript engine (goja) which enables you to write custom server-side code using plain JavaScript.
You can start by creating *.pb.js file(s) inside a pb_hooks
// pb_hooks/main.pb.js
routerAdd("GET", "/hello/{name}", (e) => {
let name = e.request.pathValue("name")
return e.json(200, { "message": "Hello " + name })
onRecordAfterUpdateSuccess((e) => {
console.log("user updated...", e.record.get("email"))
}, "users")  For convenience, when making changes to the files inside pb_hooks, the process will
automatically restart/reload itself (currently supported only on UNIX based platforms). The
*.pb.js files are loaded per their filename sort order.
For most parts, the JavaScript APIs are derived from Go with 2 main differences:
-Go exported method and field names are converted to camelCase, for example:
app.FindRecordById(&quot;example&quot;, &quot;RECORD_ID&quot;) becomes
$app.findRecordById(&quot;example&quot;, &quot;RECORD_ID&quot;).
-Errors are thrown as regular JavaScript exceptions and not returned as Go values.
##### Global objects
Below is a list with some of the commonly used global objects that are accessible from everywhere:
-__hooks
- The absolute path to the app pb_hooks directory.
-$app - The current running PocketBase application instance.
-$apis.* - API routing helpers and middlewares.
-$os.* - OS level primitives (deleting directories, executing shell commands, etc.).
-$security.* - Low level helpers for creating and parsing JWTs, random string generation, AES encryption, etc.
-And many more - for all exposed APIs, please refer to the
JSVM reference docs.
### TypeScript declarations and code completion
While you can&#39;t use directly TypeScript (without transpiling it to JS on your own), PocketBase
comes with builtin ambient TypeScript declarations that can help providing information
and documentation about the available global variables, methods and arguments, code completion, etc. as
long as your editor has TypeScript LSP support
(most editors either have it builtin or available as plugin).
The types declarations are stored in
pb_data/types.d.ts file. You can point to those declarations using the
reference triple-slash directive
at the top of your JS file:
/// &lt;reference path="../pb_data/types.d.ts" />
onBootstrap((e) => {
console.log("App initialized!")
})  If after referencing the types your editor still doesn&#39;t perform linting, then you can try to rename your
file to have .pb.ts extension.
### Caveats and limitations
##### Handlers scope
Each handler function (hook, route, middleware, etc.) is
serialized and executed in its own isolated context as a separate &quot;program&quot;. This means
that you don&#39;t have access to custom variables and functions declared outside of the handler scope. For
example, the below code will fail:
const name = "test"
onBootstrap((e) => {
console.log(name) // &lt;-- name will be undefined inside the handler
})  The above serialization and isolation context is also the reason why error stack trace line numbers may
not be accurate.
One possible workaround for sharing/reusing code across different handlers could be to move and export the
reusable code portion as local module and load it with require() inside the handler but keep in
mind that the loaded modules use a shared registry and mutations should be avoided when possible to prevent
concurrency issues:
onBootstrap((e) => {
const config = require(`${__hooks}/config.js`)
console.log(config.name)
})  ##### Relative paths
Relative file paths are relative to the current working directory (CWD) and not to the
pb_hooks.
To get an absolute path to the pb_hooks directory you can use the global
__hooks variable.
##### Loading modules
Please note that the embedded JavaScript engine is not a Node.js or browser environment, meaning
that modules that rely on APIs like window, fs,
fetch, buffer or any other runtime specific API not part of the ES5 spec may not
work!
You can load modules either by specifying their local filesystem path or by using their name, which will
automatically search in:
-the current working directory (affects also relative paths)
-any node_modules directory
-any parent node_modules directory
Currently only CommonJS (CJS) modules are supported and can be loaded with
const x = require(...).
ECMAScript modules (ESM) can be loaded by first precompiling and transforming your dependencies with a bundler
like
rollup,
webpack,
browserify, etc.
A common usage of local modules is for loading shared helpers or configuration parameters, for example:
// pb_hooks/utils.js
module.exports = {
hello: (name) => {
console.log("Hello " + name)
}    // pb_hooks/main.pb.js
onBootstrap((e) => {
const utils = require(`${__hooks}/utils.js`)
utils.hello("world")
})   Loaded modules use a shared registry and mutations should be avoided when possible to prevent
concurrency issues.
##### Performance
The prebuilt executable comes with a prewarmed pool of 15 JS runtimes, which helps
maintaining the handlers execution times on par with the Go equivalent code (see
benchmarks). You can adjust the pool size manually with the --hooksPool=50 flag (increasing the pool size may improve the performance in high concurrent scenarios but also will
increase the memory usage).
Note that the handlers performance may degrade if you have heavy computational tasks in pure JavaScript
(encryption, random generators, etc.). For such cases prefer using the exposed Go bindings
(e.g. $security.randomString(10)).
##### Engine limitations
We inherit some of the limitations and caveats of the embedded JavaScript engine
(goja):
-Has most of ES6 functionality already implemented but it is not fully spec compliant yet.
-No concurrent execution inside a single handler (aka. no setTimeout/setInterval).
-Wrapped Go structural types (such as maps, slices) comes with some peculiarities and do not behave the
exact same way as native ECMAScript values (for more details see
goja ToValue).
-In relation to the above, DB json field values require the use of get() and
set() helpers (this may change in the future).

## 26.Extend with JavaScript - Overview
# Extend with JavaScript - Overview
Overview  ### JavaScript engine
The prebuilt PocketBase v0.17+ executable comes with embedded ES5 JavaScript engine (goja) which enables you to write custom server-side code using plain JavaScript.
You can start by creating *.pb.js file(s) inside a pb_hooks
// pb_hooks/main.pb.js
routerAdd("GET", "/hello/{name}", (e) => {
let name = e.request.pathValue("name")
return e.json(200, { "message": "Hello " + name })
onRecordAfterUpdateSuccess((e) => {
console.log("user updated...", e.record.get("email"))
}, "users")  For convenience, when making changes to the files inside pb_hooks, the process will
automatically restart/reload itself (currently supported only on UNIX based platforms). The
*.pb.js files are loaded per their filename sort order.
For most parts, the JavaScript APIs are derived from Go with 2 main differences:
-Go exported method and field names are converted to camelCase, for example:
app.FindRecordById(&quot;example&quot;, &quot;RECORD_ID&quot;) becomes
$app.findRecordById(&quot;example&quot;, &quot;RECORD_ID&quot;).
-Errors are thrown as regular JavaScript exceptions and not returned as Go values.
##### Global objects
Below is a list with some of the commonly used global objects that are accessible from everywhere:
-__hooks
- The absolute path to the app pb_hooks directory.
-$app - The current running PocketBase application instance.
-$apis.* - API routing helpers and middlewares.
-$os.* - OS level primitives (deleting directories, executing shell commands, etc.).
-$security.* - Low level helpers for creating and parsing JWTs, random string generation, AES encryption, etc.
-And many more - for all exposed APIs, please refer to the
JSVM reference docs.
### TypeScript declarations and code completion
While you can&#39;t use directly TypeScript (without transpiling it to JS on your own), PocketBase
comes with builtin ambient TypeScript declarations that can help providing information
and documentation about the available global variables, methods and arguments, code completion, etc. as
long as your editor has TypeScript LSP support
(most editors either have it builtin or available as plugin).
The types declarations are stored in
pb_data/types.d.ts file. You can point to those declarations using the
reference triple-slash directive
at the top of your JS file:
/// &lt;reference path="../pb_data/types.d.ts" />
onBootstrap((e) => {
console.log("App initialized!")
})  If after referencing the types your editor still doesn&#39;t perform linting, then you can try to rename your
file to have .pb.ts extension.
### Caveats and limitations
##### Handlers scope
Each handler function (hook, route, middleware, etc.) is
serialized and executed in its own isolated context as a separate &quot;program&quot;. This means
that you don&#39;t have access to custom variables and functions declared outside of the handler scope. For
example, the below code will fail:
const name = "test"
onBootstrap((e) => {
console.log(name) // &lt;-- name will be undefined inside the handler
})  The above serialization and isolation context is also the reason why error stack trace line numbers may
not be accurate.
One possible workaround for sharing/reusing code across different handlers could be to move and export the
reusable code portion as local module and load it with require() inside the handler but keep in
mind that the loaded modules use a shared registry and mutations should be avoided when possible to prevent
concurrency issues:
onBootstrap((e) => {
const config = require(`${__hooks}/config.js`)
console.log(config.name)
})  ##### Relative paths
Relative file paths are relative to the current working directory (CWD) and not to the
pb_hooks.
To get an absolute path to the pb_hooks directory you can use the global
__hooks variable.
##### Loading modules
Please note that the embedded JavaScript engine is not a Node.js or browser environment, meaning
that modules that rely on APIs like window, fs,
fetch, buffer or any other runtime specific API not part of the ES5 spec may not
work!
You can load modules either by specifying their local filesystem path or by using their name, which will
automatically search in:
-the current working directory (affects also relative paths)
-any node_modules directory
-any parent node_modules directory
Currently only CommonJS (CJS) modules are supported and can be loaded with
const x = require(...).
ECMAScript modules (ESM) can be loaded by first precompiling and transforming your dependencies with a bundler
like
rollup,
webpack,
browserify, etc.
A common usage of local modules is for loading shared helpers or configuration parameters, for example:
// pb_hooks/utils.js
module.exports = {
hello: (name) => {
console.log("Hello " + name)
}    // pb_hooks/main.pb.js
onBootstrap((e) => {
const utils = require(`${__hooks}/utils.js`)
utils.hello("world")
})   Loaded modules use a shared registry and mutations should be avoided when possible to prevent
concurrency issues.
##### Performance
The prebuilt executable comes with a prewarmed pool of 15 JS runtimes, which helps
maintaining the handlers execution times on par with the Go equivalent code (see
benchmarks). You can adjust the pool size manually with the --hooksPool=50 flag (increasing the pool size may improve the performance in high concurrent scenarios but also will
increase the memory usage).
Note that the handlers performance may degrade if you have heavy computational tasks in pure JavaScript
(encryption, random generators, etc.). For such cases prefer using the exposed Go bindings
(e.g. $security.randomString(10)).
##### Engine limitations
We inherit some of the limitations and caveats of the embedded JavaScript engine
(goja):
-Has most of ES6 functionality already implemented but it is not fully spec compliant yet.
-No concurrent execution inside a single handler (aka. no setTimeout/setInterval).
-Wrapped Go structural types (such as maps, slices) comes with some peculiarities and do not behave the
exact same way as native ECMAScript values (for more details see
goja ToValue).
-In relation to the above, DB json field values require the use of get() and
set() helpers (this may change in the future).

## 27.Extend with JavaScript - Event hooks
# Extend with JavaScript - Event hooks
Event hooks You can extend the default PocketBase behavior with custom server-side code using the exposed JavaScript
app event hooks.
All hook handler functions share the same function(e){} signature and expect the
### App hooks
onBootstrap
onBootstrap hook is triggered when initializing the main
application resources (db, app settings, etc).
onBootstrap((e) => {
// e.app
})     onSettingsReload
onSettingsReload hook is triggered every time when the $app.settings()
is being replaced with a new state.
onSettingsReload((e) => {
// e.app.settings()
})     onBackupCreate
`onBackupCreate` is triggered on each `$app.createBackup` call.
onBackupCreate((e) => {
// e.app
// e.name    - the name of the backup to create
// e.exclude - list of pb_data dir entries to exclude from the backup
})     onBackupRestore
`onBackupRestore` is triggered before app backup restore (aka. on `$app.restoreBackup` call).
onBackupRestore((e) => {
// e.app
// e.name    - the name of the backup to restore
// e.exclude - list of dir entries to exclude from the backup
})     onTerminate
`onTerminate` hook is triggered when the app is in the process
of being terminated (ex. on `SIGTERM` signal).
Note that the app could be terminated abruptly without awaiting the hook completion.
onTerminate((e) => {
// e.app
// e.isRestart
})   ### Mailer hooks
onMailerSend
onMailerSend hook is triggered every time when a new email is
being send using the $app.newMailClient() instance.
It allows intercepting the email message or to use a custom mailer client.
onMailerSend((e) => {
// e.app
// e.mailer
// e.message
// ex. change the mail subject
e.message.subject = "new subject"
})     onMailerRecordAuthAlertSend
onMailerRecordAuthAlertSend hook is triggered when
sending a new device login auth alert email, allowing you to
intercept and customize the email message that is being sent.
onMailerRecordAuthAlertSend((e) => {
// e.app
// e.mailer
// e.message
// e.record
// e.meta
// ex. change the mail subject
e.message.subject = "new subject"
})     onMailerRecordPasswordResetSend
onMailerRecordPasswordResetSend hook is triggered when
sending a password reset email to an auth record, allowing
you to intercept and customize the email message that is being sent.
onMailerRecordPasswordResetSend((e) => {
// e.app
// e.mailer
// e.message
// e.record
// e.meta
// ex. change the mail subject
e.message.subject = "new subject"
})     onMailerRecordVerificationSend
onMailerRecordVerificationSend hook is triggered when
sending a verification email to an auth record, allowing
you to intercept and customize the email message that is being sent.
onMailerRecordVerificationSend((e) => {
// e.app
// e.mailer
// e.message
// e.record
// e.meta
// ex. change the mail subject
e.message.subject = "new subject"
})     onMailerRecordEmailChangeSend
onMailerRecordEmailChangeSend hook is triggered when sending a
confirmation new address email to an auth record, allowing
you to intercept and customize the email message that is being sent.
onMailerRecordEmailChangeSend((e) => {
// e.app
// e.mailer
// e.message
// e.record
// e.meta
// ex. change the mail subject
e.message.subject = "new subject"
})     onMailerRecordOTPSend
onMailerRecordOTPSend hook is triggered when sending an OTP email
to an auth record, allowing you to intercept and customize the
email message that is being sent.
onMailerRecordOTPSend((e) => {
// e.app
// e.mailer
// e.message
// e.record
// e.meta
// ex. change the mail subject
e.message.subject = "new subject"
})   ### Realtime hooks
onRealtimeConnectRequest
onRealtimeConnectRequest hook is triggered when establishing the SSE client connection.
onRealtimeConnectRequest((e) => {
// e.app
// e.client
// e.idleTimeout
// and all RequestEvent fields...
})     onRealtimeSubscribeRequest
`onRealtimeSubscribeRequest` hook is triggered when updating the
client subscriptions, allowing you to further validate and
modify the submitted change.
onRealtimeSubscribeRequest((e) => {
// e.app
// e.client
// e.subscriptions
// and all RequestEvent fields...
})     onRealtimeMessageSend
`onRealtimeMessageSend` hook is triggered when sending an SSE message to a client.
onRealtimeMessageSend((e) => {
// e.app
// e.client
// e.message
// and all original connect RequestEvent fields...
})   ### Record model hooks
These are lower level Record model hooks and could be triggered from anywhere (custom console command, scheduled cron job, when calling e.save(record), etc.) and therefore they have no access to the request context!
If you want to intercept the builtin Web APIs and to access their request body, query parameters, headers or the request auth state, then please use the designated
Record *Request hooks
onRecordEnrich
onRecordEnrich is triggered every time when a record is enriched
- as part of the builtin Record responses, during realtime message serialization, or when apis.enrichRecord is invoked.
It could be used for example to redact/hide or add computed temporary
Record model props only for the specific request info.
onRecordEnrich((e) => {
// hide one or more fields
e.record.hide("role")
// add new custom field for registered users
if (e.requestInfo.auth?.collection()?.name == "users") {
e.record.withCustomData(true) // for security custom props require to be enabled explicitly
e.record.set("computedScore", e.record.get("score") * e.requestInfo.auth.get("base"))
}, "posts")     onRecordValidate
onRecordValidate is a Record proxy model hook of onModelValidate.
onRecordValidate is called every time when a Record is being validated,
e.g. triggered by $app.validate() or $app.save().
// fires for every record
onRecordValidate((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordValidate((e) => {
// e.app
// e.record
}, "users", "articles")   ###### Record model create hooks
onRecordCreate
onRecordCreate is a Record proxy model hook of onModelCreate.
onRecordCreate is triggered every time when a new Record is being created,
e.g. triggered by $app.save().
and the INSERT DB statement.
and the INSERT DB statement.
Note that successful execution doesn't guarantee that the Record
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onRecordAfterCreateSuccess` or `onRecordAfterCreateError` hooks.
// fires for every record
onRecordCreate((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordCreate((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordCreateExecute
onRecordCreateExecute is a Record proxy model hook of onModelCreateExecute.
onRecordCreateExecute is triggered after successful Record validation
and right before the model INSERT DB statement execution.
Usually it is triggered as part of the $app.save() in the following firing order:
onRecordCreate
&nbsp;->
onRecordValidate (skipped with $app.saveNoValidate())
&nbsp;->
onRecordCreateExecute
Note that successful execution doesn't guarantee that the Record
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onRecordAfterCreateSuccess` or `onRecordAfterCreateError` hooks.
// fires for every record
onRecordCreateExecute((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordCreateExecute((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordAfterCreateSuccess
onRecordAfterCreateSuccess is a Record proxy model hook of onModelAfterCreateSuccess.
onRecordAfterCreateSuccess is triggered after each successful
Record DB create persistence.
Note that when a Record is persisted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
// fires for every record
onRecordAfterCreateSuccess((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordAfterCreateSuccess((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordAfterCreateError
onRecordAfterCreateError is a Record proxy model hook of onModelAfterCreateError.
onRecordAfterCreateError is triggered after each failed
Record DB create persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.save() failure
-delayed on transaction rollback
// fires for every record
onRecordAfterCreateError((e) => {
// e.app
// e.record
// e.error
// fires only for "users" and "articles" records
onRecordAfterCreateError((e) => {
// e.app
// e.record
// e.error
}, "users", "articles")   ###### Record model update hooks
onRecordUpdate
onRecordUpdate is a Record proxy model hook of onModelUpdate.
onRecordUpdate is triggered every time when a new Record is being updated,
e.g. triggered by $app.save().
and the UPDATE DB statement.
and the UPDATE DB statement.
Note that successful execution doesn't guarantee that the Record
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onRecordAfterUpdateSuccess` or `onRecordAfterUpdateError` hooks.
// fires for every record
onRecordUpdate((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordUpdate((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordUpdateExecute
onRecordUpdateExecute is a Record proxy model hook of onModelUpdateExecute.
onRecordUpdateExecute is triggered after successful Record validation
and right before the model UPDATE DB statement execution.
Usually it is triggered as part of the $app.save() in the following firing order:
onRecordUpdate
&nbsp;->
onRecordValidate (skipped with $app.saveNoValidate())
&nbsp;->
onRecordUpdateExecute
Note that successful execution doesn't guarantee that the Record
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onRecordAfterUpdateSuccess` or `onRecordAfterUpdateError` hooks.
// fires for every record
onRecordUpdateExecute((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordUpdateExecute((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordAfterUpdateSuccess
onRecordAfterUpdateSuccess is a Record proxy model hook of onModelAfterUpdateSuccess.
onRecordAfterUpdateSuccess is triggered after each successful
Record DB update persistence.
Note that when a Record is persisted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
// fires for every record
onRecordAfterUpdateSuccess((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordAfterUpdateSuccess((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordAfterUpdateError
onRecordAfterUpdateError is a Record proxy model hook of onModelAfterUpdateError.
onRecordAfterUpdateError is triggered after each failed
Record DB update persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.save() failure
-delayed on transaction rollback
// fires for every record
onRecordAfterUpdateError((e) => {
// e.app
// e.record
// e.error
// fires only for "users" and "articles" records
onRecordAfterUpdateError((e) => {
// e.app
// e.record
// e.error
}, "users", "articles")   ###### Record model delete hooks
onRecordDelete
onRecordDelete is a Record proxy model hook of onModelDelete.
onRecordDelete is triggered every time when a new Record is being deleted,
e.g. triggered by $app.delete().
and the UPDATE DB statement.
and the UPDATE DB statement.
Note that successful execution doesn't guarantee that the Record
is deleted from the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted deleted events, you can
bind to `onRecordAfterDeleteSuccess` or `onRecordAfterDeleteError` hooks.
// fires for every record
onRecordDelete((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordDelete((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordDeleteExecute
onRecordDeleteExecute is a Record proxy model hook of onModelDeleteExecute.
onRecordDeleteExecute is triggered after the internal delete checks and
right before the Record the model DELETE DB statement execution.
Usually it is triggered as part of the $app.delete() in the following firing order:
onRecordDelete
&nbsp;->
internal delete checks
&nbsp;->
onRecordDeleteExecute
Note that successful execution doesn't guarantee that the Record
is deleted from the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onRecordAfterDeleteSuccess` or `onRecordAfterDeleteError` hooks.
// fires for every record
onRecordDeleteExecute((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordDeleteExecute((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordAfterDeleteSuccess
onRecordAfterDeleteSuccess is a Record proxy model hook of onModelAfterDeleteSuccess.
onRecordAfterDeleteSuccess is triggered after each successful
Record DB delete persistence.
Note that when a Record is deleted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
// fires for every record
onRecordAfterDeleteSuccess((e) => {
// e.app
// e.record
// fires only for "users" and "articles" records
onRecordAfterDeleteSuccess((e) => {
// e.app
// e.record
}, "users", "articles")     onRecordAfterDeleteError
onRecordAfterDeleteError is a Record proxy model hook of onModelAfterDeleteError.
onRecordAfterDeleteError is triggered after each failed
Record DB delete persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.delete() failure
-delayed on transaction rollback
// fires for every record
onRecordAfterDeleteError((e) => {
// e.app
// e.record
// e.error
// fires only for "users" and "articles" records
onRecordAfterDeleteError((e) => {
// e.app
// e.record
// e.error
}, "users", "articles")   ### Collection model hooks
These are lower level Collection model hooks and could be triggered from anywhere (custom console command, scheduled cron job, when calling e.save(collection), etc.) and therefore they have no access to the request context!
If you want to intercept the builtin Web APIs and to access their request body, query parameters, headers or the request auth state, then please use the designated
Collection *Request hooks
onCollectionValidate
onCollectionValidate is a Collection proxy model hook of onModelValidate.
onCollectionValidate is called every time when a Collection is being validated,
e.g. triggered by $app.validate() or $app.save().
// fires for every collection
onCollectionValidate((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionValidate((e) => {
// e.app
// e.collection
}, "users", "articles")   ###### Collection mode create hooks
onCollectionCreate
onCollectionCreate is a Collection proxy model hook of onModelCreate.
onCollectionCreate is triggered every time when a new Collection is being created,
e.g. triggered by $app.save().
and the INSERT DB statement.
and the INSERT DB statement.
Note that successful execution doesn't guarantee that the Collection
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onCollectionAfterCreateSuccess` or `onCollectionAfterCreateError` hooks.
// fires for every collection
onCollectionCreate((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionCreate((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionCreateExecute
onCollectionCreateExecute is a Collection proxy model hook of onModelCreateExecute.
onCollectionCreateExecute is triggered after successful Collection validation
and right before the model INSERT DB statement execution.
Usually it is triggered as part of the $app.save() in the following firing order:
onCollectionCreate
&nbsp;->
onCollectionValidate (skipped with $app.saveNoValidate())
&nbsp;->
onCollectionCreateExecute
Note that successful execution doesn't guarantee that the Collection
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onCollectionAfterCreateSuccess` or `onCollectionAfterCreateError` hooks.
// fires for every collection
onCollectionCreateExecute((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionCreateExecute((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionAfterCreateSuccess
onCollectionAfterCreateSuccess is a Collection proxy model hook of onModelAfterCreateSuccess.
onCollectionAfterCreateSuccess is triggered after each successful
Collection DB create persistence.
Note that when a Collection is persisted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
// fires for every collection
onCollectionAfterCreateSuccess((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionAfterCreateSuccess((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionAfterCreateError
onCollectionAfterCreateError is a Collection proxy model hook of onModelAfterCreateError.
onCollectionAfterCreateError is triggered after each failed
Collection DB create persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.save() failure
-delayed on transaction rollback
// fires for every collection
onCollectionAfterCreateError((e) => {
// e.app
// e.collection
// e.error
// fires only for "users" and "articles" collections
onCollectionAfterCreateError((e) => {
// e.app
// e.collection
// e.error
}, "users", "articles")   ###### Collection mode update hooks
onCollectionUpdate
onCollectionUpdate is a Collection proxy model hook of onModelUpdate.
onCollectionUpdate is triggered every time when a new Collection is being updated,
e.g. triggered by $app.save().
and the UPDATE DB statement.
and the UPDATE DB statement.
Note that successful execution doesn't guarantee that the Collection
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onCollectionAfterUpdateSuccess` or `onCollectionAfterUpdateError` hooks.
// fires for every collection
onCollectionUpdate((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionUpdate((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionUpdateExecute
onCollectionUpdateExecute is a Collection proxy model hook of onModelUpdateExecute.
onCollectionUpdateExecute is triggered after successful Collection validation
and right before the model UPDATE DB statement execution.
Usually it is triggered as part of the $app.save() in the following firing order:
onCollectionUpdate
&nbsp;->
onCollectionValidate (skipped with $app.saveNoValidate())
&nbsp;->
onCollectionUpdateExecute
Note that successful execution doesn't guarantee that the Collection
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onCollectionAfterUpdateSuccess` or `onCollectionAfterUpdateError` hooks.
// fires for every collection
onCollectionUpdateExecute((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionUpdateExecute((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionAfterUpdateSuccess
onCollectionAfterUpdateSuccess is a Collection proxy model hook of onModelAfterUpdateSuccess.
onCollectionAfterUpdateSuccess is triggered after each successful
Collection DB update persistence.
Note that when a Collection is persisted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
// fires for every collection
onCollectionAfterUpdateSuccess((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionAfterUpdateSuccess((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionAfterUpdateError
onCollectionAfterUpdateError is a Collection proxy model hook of onModelAfterUpdateError.
onCollectionAfterUpdateError is triggered after each failed
Collection DB update persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.save() failure
-delayed on transaction rollback
// fires for every collection
onCollectionAfterUpdateError((e) => {
// e.app
// e.collection
// e.error
// fires only for "users" and "articles" collections
onCollectionAfterUpdateError((e) => {
// e.app
// e.collection
// e.error
}, "users", "articles")   ###### Collection mode delete hooks
onCollectionDelete
onCollectionDelete is a Collection proxy model hook of onModelDelete.
onCollectionDelete is triggered every time when a new Collection is being deleted,
e.g. triggered by $app.delete().
and the UPDATE DB statement.
and the UPDATE DB statement.
Note that successful execution doesn't guarantee that the Collection
is deleted from the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted deleted events, you can
bind to `onCollectionAfterDeleteSuccess` or `onCollectionAfterDeleteError` hooks.
// fires for every collection
onCollectionDelete((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionDelete((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionDeleteExecute
onCollectionDeleteExecute is a Collection proxy model hook of onModelDeleteExecute.
onCollectionDeleteExecute is triggered after the internal delete checks and
right before the Collection the model DELETE DB statement execution.
Usually it is triggered as part of the $app.delete() in the following firing order:
onCollectionDelete
&nbsp;->
internal delete checks
&nbsp;->
onCollectionDeleteExecute
Note that successful execution doesn't guarantee that the Collection
is deleted from the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onCollectionAfterDeleteSuccess` or `onCollectionAfterDeleteError` hooks.
// fires for every collection
onCollectionDeleteExecute((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionDeleteExecute((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionAfterDeleteSuccess
onCollectionAfterDeleteSuccess is a Collection proxy model hook of onModelAfterDeleteSuccess.
onCollectionAfterDeleteSuccess is triggered after each successful
Collection DB delete persistence.
Note that when a Collection is deleted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
// fires for every collection
onCollectionAfterDeleteSuccess((e) => {
// e.app
// e.collection
// fires only for "users" and "articles" collections
onCollectionAfterDeleteSuccess((e) => {
// e.app
// e.collection
}, "users", "articles")     onCollectionAfterDeleteError
onCollectionAfterDeleteError is a Collection proxy model hook of onModelAfterDeleteError.
onCollectionAfterDeleteError is triggered after each failed
Collection DB delete persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.delete() failure
-delayed on transaction rollback
// fires for every collection
onCollectionAfterDeleteError((e) => {
// e.app
// e.collection
// e.error
// fires only for "users" and "articles" collections
onCollectionAfterDeleteError((e) => {
// e.app
// e.collection
// e.error
}, "users", "articles")   ### Request hooks
The request hooks are triggered only when the corresponding API request endpoint is accessed.
###### Record CRUD request hooks
onRecordsListRequest
onRecordsListRequest hook is triggered on each API Records list request.
Could be used to validate or modify the response before returning it to the client.
Note that if you want to hide existing or add new computed Record fields prefer using the
`onRecordEnrich`
hook because it is less error-prone and it is triggered
by all builtin Record responses (including when sending realtime Record events).
// fires for every collection
onRecordsListRequest((e) => {
// e.app
// e.collection
// e.records
// e.result
// and all RequestEvent fields...
// fires only for "users" and "articles" collections
onRecordsListRequest((e) => {
// e.app
// e.collection
// e.records
// e.result
// and all RequestEvent fields...
}, "users", "articles")     onRecordViewRequest
onRecordViewRequest hook is triggered on each API Record view request.
Could be used to validate or modify the response before returning it to the client.
Note that if you want to hide existing or add new computed Record fields prefer using the
`onRecordEnrich`
hook because it is less error-prone and it is triggered
by all builtin Record responses (including when sending realtime Record events).
// fires for every collection
onRecordViewRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "articles" collections
onRecordViewRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "articles")     onRecordCreateRequest
onRecordCreateRequest hook is triggered on each API Record create request.
Could be used to additionally validate the request data or implement
completely different persistence behavior.
// fires for every collection
onRecordCreateRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "articles" collections
onRecordCreateRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "articles")     onRecordUpdateRequest
onRecordUpdateRequest hook is triggered on each API Record update request.
Could be used to additionally validate the request data or implement
completely different persistence behavior.
// fires for every collection
onRecordUpdateRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "articles" collections
onRecordUpdateRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "articles")     onRecordDeleteRequest
onRecordDeleteRequest hook is triggered on each API Record delete request.
Could be used to additionally validate the request data or implement
completely different delete behavior.
// fires for every collection
onRecordDeleteRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "articles" collections
onRecordDeleteRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "articles")   ###### Record auth request hooks
onRecordAuthRequest
onRecordAuthRequest hook is triggered on each successful API
record authentication request (sign-in, token refresh, etc.).
Could be used to additionally validate or modify the authenticated
record data and token.
// fires for every auth collection
onRecordAuthRequest((e) => {
// e.app
// e.record
// e.token
// e.meta
// e.authMethod
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordAuthRequest((e) => {
// e.app
// e.record
// e.token
// e.meta
// e.authMethod
// and all RequestEvent fields...
}, "users", "managers")     onRecordAuthRefreshRequest
onRecordAuthRefreshRequest hook is triggered on each Record
auth refresh API request (right before generating a new auth token).
Could be used to additionally validate the request data or implement
completely different auth refresh behavior.
// fires for every auth collection
onRecordAuthRefreshRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordAuthRefreshRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "managers")     onRecordAuthWithPasswordRequest
onRecordAuthWithPasswordRequest hook is triggered on each
Record auth with password API request.
e.record could be nil if no matching identity is found, allowing
you to manually locate a different Record model (by reassigning e.record).
// fires for every auth collection
onRecordAuthWithPasswordRequest((e) => {
// e.app
// e.collection
// e.record (could be null)
// e.identity
// e.identityField
// e.password
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordAuthWithPasswordRequest((e) => {
// e.app
// e.collection
// e.record (could be null)
// e.identity
// e.identityField
// e.password
// and all RequestEvent fields...
}, "users", "managers")     onRecordAuthWithOAuth2Request
onRecordAuthWithOAuth2Request hook is triggered on each Record
OAuth2 sign-in/sign-up API request (after token exchange and before external provider linking).
If e.record is not set, then the OAuth2
request will try to create a new auth record.
To assign or link a different existing record model you can
change the e.record field.
// fires for every auth collection
onRecordAuthWithOAuth2Request((e) => {
// e.app
// e.collection
// e.providerName
// e.providerClient
// e.record (could be null)
// e.oauth2User
// e.createData
// e.isNewRecord
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordAuthWithOAuth2Request((e) => {
// e.app
// e.collection
// e.providerName
// e.providerClient
// e.record (could be null)
// e.oauth2User
// e.createData
// e.isNewRecord
// and all RequestEvent fields...
}, "users", "managers")     onRecordRequestPasswordResetRequest
onRecordRequestPasswordResetRequest hook is triggered on
each Record request password reset API request.
Could be used to additionally validate the request data or implement
completely different password reset behavior.
// fires for every auth collection
onRecordRequestPasswordResetRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordRequestPasswordResetRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "managers")     onRecordConfirmPasswordResetRequest
onRecordConfirmPasswordResetRequest hook is triggered on
each Record confirm password reset API request.
Could be used to additionally validate the request data or implement
completely different persistence behavior.
// fires for every auth collection
onRecordConfirmPasswordResetRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordConfirmPasswordResetRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "managers")     onRecordRequestVerificationRequest
onRecordRequestVerificationRequest hook is triggered on
each Record request verification API request.
Could be used to additionally validate the loaded request data or implement
completely different verification behavior.
// fires for every auth collection
onRecordRequestVerificationRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordRequestVerificationRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "managers")     onRecordConfirmVerificationRequest
onRecordConfirmVerificationRequest hook is triggered on each
Record confirm verification API request.
Could be used to additionally validate the request data or implement
completely different persistence behavior.
// fires for every auth collection
onRecordConfirmVerificationRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordConfirmVerificationRequest((e) => {
// e.app
// e.collection
// e.record
// and all RequestEvent fields...
}, "users", "managers")     onRecordRequestEmailChangeRequest
onRecordRequestEmailChangeRequest hook is triggered on each
Record request email change API request.
Could be used to additionally validate the request data or implement
completely different request email change behavior.
// fires for every auth collection
onRecordRequestEmailChangeRequest((e) => {
// e.app
// e.collection
// e.record
// e.newEmail
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordRequestEmailChangeRequest((e) => {
// e.app
// e.collection
// e.record
// e.newEmail
// and all RequestEvent fields...
}, "users", "managers")     onRecordConfirmEmailChangeRequest
onRecordConfirmEmailChangeRequest hook is triggered on each
Record confirm email change API request.
Could be used to additionally validate the request data or implement
completely different persistence behavior.
// fires for every auth collection
onRecordConfirmEmailChangeRequest((e) => {
// e.app
// e.collection
// e.record
// e.newEmail
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordConfirmEmailChangeRequest((e) => {
// e.app
// e.collection
// e.record
// e.newEmail
// and all RequestEvent fields...
}, "users", "managers")     onRecordRequestOTPRequest
onRecordRequestOTPRequest hook is triggered on each Record
request OTP API request.
e.record could be nil if no user with the requested email is found, allowing
you to manually create a new Record or locate a different Record model (by reassigning e.record).
// fires for every auth collection
onRecordRequestOTPRequest((e) => {
// e.app
// e.collection
// e.record (could be null)
// e.password
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordRequestOTPRequest((e) => {
// e.app
// e.collection
// e.record (could be null)
// e.password
// and all RequestEvent fields...
}, "users", "managers")     onRecordAuthWithOTPRequest
onRecordAuthWithOTPRequest hook is triggered on each Record
auth with OTP API request.
// fires for every auth collection
onRecordAuthWithOTPRequest((e) => {
// e.app
// e.collection
// e.record
// e.otp
// and all RequestEvent fields...
// fires only for "users" and "managers" auth collections
onRecordAuthWithOTPRequest((e) => {
// e.app
// e.collection
// e.record
// e.otp
// and all RequestEvent fields...
}, "users", "managers")   ###### Batch request hooks
onBatchRequest
onBatchRequest hook is triggered on each API batch request.
Could be used to additionally validate or modify the submitted batch requests.
This hook will also fire the corresponding onRecordCreateRequest, onRecordUpdateRequest, onRecordDeleteRequest hooks, where e.app is the batch transactional app.
onBatchRequest((e) => {
// e.app
// e.batch
// and all RequestEvent fields...
})   ###### File request hooks
Could be used to validate or modify the file response before returning it to the client.
// e.app
// e.collection
// e.record
// e.fileField
// e.servedPath
// e.servedName
// and all RequestEvent fields...
})     onFileTokenRequest
onFileTokenRequest hook is triggered on each auth file token API request.
// fires for every auth model
onFileTokenRequest((e) => {
// e.app
// e.record
// e.token
// and all RequestEvent fields...
// fires only for "users"
onFileTokenRequest((e) => {
// e.app
// e.record
// e.token
// and all RequestEvent fields...
}, "users")   ###### Collection request hooks
onCollectionsListRequest
`onCollectionsListRequest` hook is triggered on each API Collections list request.
Could be used to validate or modify the response before returning it to the client.
onCollectionsListRequest((e) => {
// e.app
// e.collections
// e.result
// and all RequestEvent fields...
})     onCollectionViewRequest
`onCollectionViewRequest` hook is triggered on each API Collection view request.
Could be used to validate or modify the response before returning it to the client.
onCollectionViewRequest((e) => {
// e.app
// e.collection
// and all RequestEvent fields...
})     onCollectionCreateRequest
`onCollectionCreateRequest` hook is triggered on each API Collection create request.
Could be used to additionally validate the request data or implement
completely different persistence behavior.
onCollectionCreateRequest((e) => {
// e.app
// e.collection
// and all RequestEvent fields...
})     onCollectionUpdateRequest
`onCollectionUpdateRequest` hook is triggered on each API Collection update request.
Could be used to additionally validate the request data or implement
completely different persistence behavior.
onCollectionUpdateRequest((e) => {
// e.app
// e.collection
// and all RequestEvent fields...
})     onCollectionDeleteRequest
`onCollectionDeleteRequest` hook is triggered on each API Collection delete request.
Could be used to additionally validate the request data or implement
completely different delete behavior.
onCollectionDeleteRequest((e) => {
// e.app
// e.collection
// and all RequestEvent fields...
})     onCollectionsImportRequest
`onCollectionsImportRequest` hook is triggered on each API
collections import request.
Could be used to additionally validate the imported collections or
to implement completely different import behavior.
onCollectionsImportRequest((e) => {
// e.app
// e.collectionsData
// e.deleteMissing
})   ###### Settings request hooks
onSettingsListRequest
`onSettingsListRequest` hook is triggered on each API Settings list request.
Could be used to validate or modify the response before returning it to the client.
onSettingsListRequest((e) => {
// e.app
// e.settings
// and all RequestEvent fields...
})     onSettingsUpdateRequest
`onSettingsUpdateRequest` hook is triggered on each API Settings update request.
Could be used to additionally validate the request data or
implement completely different persistence behavior.
onSettingsUpdateRequest((e) => {
// e.app
// e.oldSettings
// e.newSettings
// and all RequestEvent fields...
})   ### Base model hooks
The Model hooks are fired for all PocketBase structs that implements the Model DB interface - Record, Collection, Log, etc.
For convenience, if you want to listen to only the Record or Collection DB model
events without doing manual type assertion, you can use the
onRecord*
and
onCollection*
proxy hooks above.
onModelValidate
onModelValidate is called every time when a Model is being validated,
e.g. triggered by $app.validate() or $app.save().
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelValidate((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelValidate((e) => {
// e.app
// e.model
}, "users", "articles")   ###### Base model create hooks
onModelCreate
onModelCreate is triggered every time when a new Model is being created,
e.g. triggered by $app.save().
and the INSERT DB statement.
and the INSERT DB statement.
Note that successful execution doesn't guarantee that the Model
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onModelAfterCreateSuccess` or `onModelAfterCreateError` hooks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelCreate((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelCreate((e) => {
// e.app
// e.model
}, "users", "articles")     onModelCreateExecute
onModelCreateExecute is triggered after successful Model validation
and right before the model INSERT DB statement execution.
Usually it is triggered as part of the $app.save() in the following firing order:
onModelCreate
&nbsp;->
onModelValidate (skipped with $app.saveNoValidate())
&nbsp;->
onModelCreateExecute
Note that successful execution doesn't guarantee that the Model
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onModelAfterCreateSuccess` or `onModelAfterCreateError` hooks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelCreateExecute((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelCreateExecute((e) => {
// e.app
// e.model
}, "users", "articles")     onModelAfterCreateSuccess
onModelAfterCreateSuccess is triggered after each successful
Model DB create persistence.
Note that when a Model is persisted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelAfterCreateSuccess((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelAfterCreateSuccess((e) => {
// e.app
// e.model
}, "users", "articles")     onModelAfterCreateError
onModelAfterCreateError is triggered after each failed
Model DB create persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.save() failure
-delayed on transaction rollback
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelAfterCreateError((e) => {
// e.app
// e.model
// e.error
// fires only for "users" and "articles" models
onModelAfterCreateError((e) => {
// e.app
// e.model
// e.error
}, "users", "articles")   ###### Base model update hooks
onModelUpdate
onModelUpdate is triggered every time when a new Model is being updated,
e.g. triggered by $app.save().
and the UPDATE DB statement.
and the UPDATE DB statement.
Note that successful execution doesn't guarantee that the Model
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onModelAfterUpdateSuccess` or `onModelAfterUpdateError` hooks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelUpdate((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelUpdate((e) => {
// e.app
// e.model
}, "users", "articles")     onModelUpdateExecute
onModelUpdateExecute is triggered after successful Model validation
and right before the model UPDATE DB statement execution.
Usually it is triggered as part of the $app.save() in the following firing order:
onModelUpdate
&nbsp;->
onModelValidate (skipped with $app.saveNoValidate())
&nbsp;->
onModelUpdateExecute
Note that successful execution doesn't guarantee that the Model
is persisted in the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onModelAfterUpdateSuccess` or `onModelAfterUpdateError` hooks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelUpdateExecute((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelUpdateExecute((e) => {
// e.app
// e.model
}, "users", "articles")     onModelAfterUpdateSuccess
onModelAfterUpdateSuccess is triggered after each successful
Model DB update persistence.
Note that when a Model is persisted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelAfterUpdateSuccess((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelAfterUpdateSuccess((e) => {
// e.app
// e.model
}, "users", "articles")     onModelAfterUpdateError
onModelAfterUpdateError is triggered after each failed
Model DB update persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.save() failure
-delayed on transaction rollback
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelAfterUpdateError((e) => {
// e.app
// e.model
// e.error
// fires only for "users" and "articles" models
onModelAfterUpdateError((e) => {
// e.app
// e.model
// e.error
}, "users", "articles")   ###### Base model delete hooks
onModelDelete
onModelDelete is triggered every time when a new Model is being deleted,
e.g. triggered by $app.delete().
and the UPDATE DB statement.
and the UPDATE DB statement.
Note that successful execution doesn't guarantee that the Model
is deleted from the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted deleted events, you can
bind to `onModelAfterDeleteSuccess` or `onModelAfterDeleteError` hooks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelDelete((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelDelete((e) => {
// e.app
// e.model
}, "users", "articles")     onModelDeleteExecute
onModelDeleteExecute is triggered after the internal delete checks and
right before the Model the model DELETE DB statement execution.
Usually it is triggered as part of the $app.delete() in the following firing order:
onModelDelete
&nbsp;->
internal delete checks
&nbsp;->
onModelDeleteExecute
Note that successful execution doesn't guarantee that the Model
is deleted from the database since its wrapping transaction may
not have been committed yet.
If you want to listen to only the actual persisted events, you can
bind to `onModelAfterDeleteSuccess` or `onModelAfterDeleteError` hooks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelDeleteExecute((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelDeleteExecute((e) => {
// e.app
// e.model
}, "users", "articles")     onModelAfterDeleteSuccess
onModelAfterDeleteSuccess is triggered after each successful
Model DB delete persistence.
Note that when a Model is deleted as part of a transaction,
this hook is delayed and executed only AFTER the transaction has been committed.
This hook is NOT triggered in case the transaction fails/rollbacks.
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelAfterDeleteSuccess((e) => {
// e.app
// e.model
// fires only for "users" and "articles" models
onModelAfterDeleteSuccess((e) => {
// e.app
// e.model
}, "users", "articles")     onModelAfterDeleteError
onModelAfterDeleteError is triggered after each failed
Model DB delete persistence.
Note that the execution of this hook is either immediate or delayed
depending on the error:
-immediate on $app.delete() failure
-delayed on transaction rollback
For convenience, if you want to listen to only the Record or Collection models
events without doing manual type assertion, you can use the equivalent onRecord* and onCollection* proxy hooks.
// fires for every model
onModelAfterDeleteError((e) => {
// e.app
// e.model
// e.error
// fires only for "users" and "articles" models
onModelAfterDeleteError((e) => {
// e.app
// e.model
// e.error
}, "users", "articles")

## 28.Extend with JavaScript - Routing
GET /hello/{name}"
# Extend with JavaScript - Routing
`GET /hello/{name}"`
Routing You can register custom routes and middlewares by using the top-level
routerAdd()
and
routerUse()
functions.
### Routes
##### Registering new routes
Every route has a path, handler function and eventually middlewares attached to it. For example:
// register "GET /hello/{name}" route (allowed for everyone)
routerAdd("GET", "/hello/{name}", (e) => {
let name = e.request.pathValue("name")
return e.json(200, { "message": "Hello " + name })
// register "POST /api/myapp/settings" route (allowed only for authenticated users)
routerAdd("POST", "/api/myapp/settings", (e) => {
// do something ...
return e.json(200, {"success": true})
}, $apis.requireAuth())  ##### Path parameters and matching rules
Because PocketBase routing is based on top of the Go standard router mux, we follow the same pattern
matching rules. Below you could find a short overview but for more details please refer to
net/http.ServeMux.
In general, a route pattern looks like [METHOD ][HOST]/[PATH].
Route paths can include parameters in the format {paramName}.
You can also use {paramName...} format to specify a parameter that targets more than one path
segment.
A pattern ending with a trailing slash / acts as anonymous wildcard and matches any requests
that begins with the defined route. If you want to have a trailing slash but to indicate the end of the
URL then you need to end the path with the special
{$} parameter.
If your route path starts with /api/
consider combining it with your unique app name like /api/myapp/... to avoid collisions
with system routes.
Here are some examples:
// match "GET /index.html" (for any host)
routerAdd("GET", "/index.html", ...)
// match "GET /static/", "GET /static/a/b/c", etc.
routerAdd("GET", "/static/", ...)
// match "GET /static/", "GET /static/a/b/c", etc.
// (similar to the above but with a named wildcard parameter)
routerAdd("GET", "/static/{path...}", ...)
// match only "GET /static/" (if no "/static" is registered, it is 301 redirected)
routerAdd("GET", "/static/{$}", ...)
// match "GET /customers/john", "GET /customers/jane", etc.
routerAdd("GET", "/customers/{name}", ...)   In the following examples e is usually
core.RequestEvent value.
##### Reading path parameters
`let id = e.request.pathValue("id")`  ##### Retrieving the current auth state
The request auth state can be accessed (or set) via the RequestEvent.auth field.
let authRecord = e.auth
let isGuest = !e.auth
// the same as "e.auth?.isSuperuser()"
let isSuperuser = e.hasSuperuserAuth()  Alternatively you could also access the request data from the summarized request info instance
(usually used in hooks like the onRecordEnrich where there is no direct access to the request)
let info = e.requestInfo()
let authRecord = info.auth
let isGuest = !info.auth
// the same as "info.auth?.isSuperuser()"
let isSuperuser = info.hasSuperuserAuth()  ##### Reading query parameters
let search = e.request.url.query().get("search")
// or via the parsed request info
let search = e.requestInfo().query["search"]  ##### Reading request headers
let token = e.request.header.get("Some-Header")
// or via the parsed request info
// (the header value is always normalized per the @request.headers.* API rules format)
let token = e.requestInfo().headers["some_header"]  ##### Writing response headers
`e.response.header().set("Some-Header", "123")`  ##### Retrieving uploaded files
// retrieve the uploaded files and parse the found multipart data into a ready-to-use []*filesystem.File
let files = e.findUploadedFiles("document")
let [mf, mh] = e.request.formFile("document")  ##### Reading request body
Body parameters can be read either via
e.bindBody
OR through the parsed request info.
console.log(toString(e.request.body))
// read the body fields via the parsed request object
let body = e.requestInfo().body
console.log(body.title)
// OR read/scan the request body fields into a typed object
const data = new DynamicModel({
// describe the fields to read (used also as initial values)
someTextField:   "",
someIntValue:    0,
someFloatValue:  -0,
someBoolField:   false,
someArrayField:  [],
someObjectField: {}, // object props are accessible via .get(key)
e.bindBody(data)
console.log(data.sometextField)  ##### Writing response body
// send response with JSON body
// (it also provides a generic response fields picker/filter if the "fields" query parameter is set)
e.json(200, {"name": "John"})
// send response with string body
// send response with HTML body
// (check also the "Rendering templates" section)
e.html(200, "&lt;h1>Hello!&lt;/h1>")
// redirect
// send response with no body
e.noContent(204)
// serve a single file
e.fileFS($os.dirFS("..."), "example.txt")
// stream the specified reader
e.stream(200, "application/octet-stream", reader)
// send response with blob (bytes array) body
e.blob(200, "application/octet-stream", [ ... ])  ##### Reading the client IP
// The IP of the last client connecting to your server.
// The returned IP is safe and can be always trusted.
// When behind a reverse proxy (e.g. nginx) this method returns the IP of the proxy.
// (/jsvm/interfaces/core.RequestEvent.html#remoteIP)
let ip = e.remoteIP()
// The "real" IP of the client based on the configured Settings.trustedProxy header(s).
// If such headers are not set, it fallbacks to e.remoteIP().
// (/jsvm/interfaces/core.RequestEvent.html#realIP)
let ip = e.realIP()  ##### Request store
The core.RequestEvent comes with a local store that you can use to share custom data between
middlewares and the route action.
// store for the duration of the request
e.set("someKey", 123)
// retrieve later
let val = e.get("someKey") // 123  ### Middlewares
Middlewares allow inspecting, intercepting and filtering route requests.
Middlewares can be registered both to a single route (by passing them after the handler) and globally usually
by using routerUse(middleware).
##### Registering middlewares
Here is a minimal example of what a global middleware looks like:
// register a global middleware
routerUse((e) => {
if (e.request.header.get("Something") == "") {
throw new BadRequestError("Something header value is missing!")
})  Middleware can be either registered as simple functions (function(e){} ) or if you want
to specify a custom priority and id - as a
Middleware
class instance.
Below is a slightly more advanced example showing all options and the execution sequence:
// attach global middleware
routerUse((e) => {
console.log(1)
// attach global middleware with a custom priority
routerUse(new Middleware((e) => {
console.log(2)
}, -1))
// attach middleware to a single route
// "GET /hello" should print the sequence: 2,1,3,4
routerAdd("GET", "/hello", (e) => {
console.log(4)
return e.string(200, "Hello!")
}, (e) => {
console.log(3)
})  ##### Builtin middlewares
The global
$apis.*
object exposes several middlewares that you can use as part of your application.
// Require the request client to be unauthenticated (aka. guest).
$apis.requireGuestOnly()
// Require the request client to be authenticated
// (optionally specify a list of allowed auth collection names, default to any).
$apis.requireAuth(optCollectionNames...)
// Require the request client to be authenticated as superuser
// (this is an alias for $apis.requireAuth("_superusers")).
$apis.requireSuperuserAuth()
// Require the request client to be authenticated as superuser OR
// regular auth record with id matching the specified route parameter (default to "id").
$apis.requireSuperuserOrOwnerAuth(ownerIdParam)
// Changes the global 32MB default request body size limit (set it to 0 for no limit).
// Note that system record routes have dynamic body size limit based on their collection field types.
$apis.bodyLimit(limitBytes)
// Compresses the HTTP response using Gzip compression scheme.
$apis.gzip()
// Instructs the activity logger to log only requests that have failed/returned an error.
$apis.skipSuccessActivityLog()  ##### Default globally registered middlewares
The below list is mostly useful for users that may want to plug their own custom middlewares before/after
the priority of the default global ones, for example: registering a custom auth loader before the rate
limiter with `-1001` so that the rate limit can be applied properly based on the loaded auth state. All PocketBase applications have the below internal middlewares registered out of the box (sorted by their priority):
-WWW redirect (id: pbWWWRedirect, priority: -99999)  Performs www -&gt; non-www redirect(s) if the request host matches with one of the values in
certificate host policy.
-CORS (id: pbCors, priority: -1041)  By default all origins are allowed (PocketBase is stateless and doesn&#39;t rely on cookies) but this
can be configured with the --origins flag.
-Activity logger (id: pbActivityLogger, priority: -1040)  Saves request information into the logs auxiliary database.
-Auto panic recover (id: pbPanicRecover, priority: -1030)  Default panic-recover handler.
-Auth token loader (id: pbLoadAuthToken, priority: -1020)  Loads the auth token from the Authorization header and populates the related auth
record into the request event (aka. e.auth).
-Security response headers (id: pbSecurityHeaders, priority: -1010)  Adds default common security headers (X-XSS-Protection,
X-Content-Type-Options,
X-Frame-Options) to the response (can be overwritten by other middlewares or from
inside the route action).
-Rate limit (id: pbRateLimit, priority: -1000)  Rate limits client requests based on the configured app settings (it does nothing if the rate
limit option is not enabled).
-Body limit (id: pbBodyLimit, priority: -990)  Applies a default max ~32MB request body limit for all custom routes ( system record routes have
dynamic body size limit based on their collection field types). Can be overwritten on group/route
level by simply rebinding the $apis.bodyLimit(limitBytes) middleware.
### Error response
PocketBase has a global error handler and every returned or thrown Error from a route or
middleware will be safely converted by default to a generic API error to avoid accidentally leaking
sensitive information (the original error will be visible only in the Dashboard &gt; Logs or when in
--dev mode).
To make it easier returning formatted json error responses, PocketBase provides
ApiError constructor that can be instantiated directly or using the builtin factories.
ApiError.data will be returned in the response only if it is a map of
ValidationError items.
// construct ApiError with custom status code and validation data error
throw new ApiError(500, "something went wrong", {
"title": new ValidationError("invalid_title", "Invalid or missing title"),
// if message is empty string, a default one will be set
throw new BadRequestError(optMessage, optData)      // 400 ApiError
throw new UnauthorizedError(optMessage, optData)    // 401 ApiError
throw new ForbiddenError(optMessage, optData)       // 403 ApiError
throw new NotFoundError(optMessage, optData)        // 404 ApiError
throw new TooManyrequestsError(optMessage, optData) // 429 ApiError
throw new InternalServerError(optMessage, optData)  // 500 ApiError  ### Helpers
##### Serving static directory
$apis.static()
serves static directory content from fs.FS instance.
Expects the route to have a {path...} wildcard parameter.
// serves static files from the provided dir (if exists)
routerAdd("GET", "/{path...}", $apis.static($os.dirFS("/path/to/public"), false))  ##### Auth response
$apis.recordAuthResponse()
writes standardized JSON record auth response (aka. token + record data) into the specified request body. Could
be used as a return result from a custom auth route.
routerAdd("POST", "/phone-login", (e) => {
const data = new DynamicModel({
phone:    "",
password: "",
e.bindBody(data)
let record = e.app.findFirstRecordByData("users", "phone", data.phone)
if !record.validatePassword(data.password) {
// return generic 400 error as a basic enumeration protection
throw new BadRequestError("Invalid credentials")
return $apis.recordAuthResponse(e, record, "phone")
})  ##### Enrich record(s)
$apis.enrichRecord()
and
$apis.enrichRecords()
helpers parses the request context and enrich the provided record(s) by:
-expands relations (if defaultExpands and/or ?expand query parameter is set)
-ensures that the emails of the auth record and its expanded auth relations are visible only for the
current logged superuser, record owner or record with manage access
These helpers are also responsible for triggering the onRecordEnrich hook events.
routerAdd("GET", "/custom-article", (e) => {
let records = e.app.findRecordsByFilter("article", "status = 'active'", "-created", 40, 0)
// enrich the records with the "categories" relation as default expand
$apis.enrichRecords(e, records, "categories")
return e.json(200, records)
})  ### Sending request to custom routes using the SDKs
The official PocketBase SDKs expose the internal send() method that could be used to send requests
to your custom route(s).
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.send("/hello", {
// for other options check
// https://developer.mozilla.org/en-US/docs/Web/API/fetch#options
query: { "abc": 123 },
});  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.send("/hello", query: { "abc": 123 })

## 29.Extend with JavaScript - Database
# Extend with JavaScript - Database
Database $app
is the main interface to interact with your database.
$app.db()
For more details and examples how to interact with Record and Collection models programmatically
you could also check Collection operations
and
Record operations sections.
### Executing queries
To execute DB queries you can start with the newQuery(&quot;...&quot;) statement and then call one of:
-execute()
- for any query statement that is not meant to retrieve data:
$app.db()
.newQuery("DELETE FROM articles WHERE status = 'archived'")
.execute() // throw an error on db failure
-one()
- to populate a single row into DynamicModel object:
const result = new DynamicModel({
// describe the shape of the data (used also as initial values)
// the keys cannot start with underscore and must be a valid Go struct field name
"id":     "",
"status": false,
"age":    0, // use -0 for a float value
"roles":  [], // serialized json db arrays are decoded as plain arrays
$app.db()
.newQuery("SELECT id, status, age, roles FROM users WHERE id=1")
.one(result) // throw an error on db failure or missing row
console.log(result.id)
-all()
- to populate multiple rows into an array of objects (note that the array must be created with
arrayOf):
const result = arrayOf(new DynamicModel({
// describe the shape of the data (used also as initial values)
// the keys cannot start with underscore and must be a valid Go struct field name
"id":     "",
"status": false,
"age":    0, // use -0 for a float value
"roles":  [], // serialized json db arrays are decoded as plain arrays
$app.db()
.newQuery("SELECT id, status, age, roles FROM users LIMIT 100")
.all(result) // throw an error on db failure
if (result.length > 0) {
console.log(result[0].id)
### Binding parameters
To prevent SQL injection attacks, you should use named parameters for any expression value that comes from
user input. This could be done using the named {:paramName}
bind(params). For example:
const result = arrayOf(new DynamicModel({
"name":    "",
"created": "",
$app.db()
.newQuery("SELECT name, created FROM posts WHERE created >= {:from} and created &lt;= {:to}")
.bind({
"from": "2023-06-25 00:00:00.000Z",
"to":   "2023-06-28 23:59:59.999Z",
.all(result)
console.log(result.length)  ### Query builder
Instead of writing plain SQLs, you can also compose SQL statements programmatically using the db query
builder.
Every SQL keyword has a corresponding query building method. For example, SELECT corresponds
to select(), FROM corresponds to from(),
WHERE corresponds to where(), and so on.
const result = arrayOf(new DynamicModel({
"id":    "",
"email": "",
$app.db()
.select("id", "email")
.from("users")
.limit(100)
.orderBy("created ASC")
.all(result)  ##### select(), andSelect(), distinct()
The select(...cols) method initializes a SELECT query builder. It accepts a list
of the column names to be selected.
To add additional columns to an existing select query, you can call andSelect().
To select distinct rows, you can call distinct(true).
$app.db()
.select("id", "avatar as image")
.andSelect("(firstName || ' ' || lastName) as fullName")
.distinct(true)
...  ##### from()
The from(...tables) method specifies which tables to select from (plain table names are automatically
quoted).
$app.db()
.select("table1.id", "table2.name")
.from("table1", "table2")
...  ##### join()
The join(type, table, on) method specifies a JOIN clause. It takes 3 parameters:
-type - join type string like INNER JOIN, LEFT JOIN, etc.
-table - the name of the table to be joined
-on - optional dbx.Expression as an ON clause
For convenience, you can also use the shortcuts innerJoin(table, on),
leftJoin(table, on),
rightJoin(table, on) to specify INNER JOIN, LEFT JOIN and
RIGHT JOIN, respectively.
$app.db()
.select("users.*")
.from("users")
.innerJoin("profiles", $dbx.exp("profiles.user_id = users.id"))
.join("FULL OUTER JOIN", "department", $dbx.exp("department.id = {:id}", {id: "someId"}))
...  ##### where(), andWhere(), orWhere()
The where(exp) method specifies the WHERE condition of the query.
You can also use andWhere(exp) or orWhere(exp) to append additional one or more
conditions to an existing WHERE clause.
Each where condition accepts a single dbx.Expression (see below for full list).
SELECT users.*
FROM users
WHERE id = "someId" AND
status = "public" AND
name like "%john%" OR
role = "manager" AND
fullTime IS TRUE AND
experience > 10
$app.db()
.select("users.*")
.from("users")
.where($dbx.exp("id = {:id}", { id: "someId" }))
.andWhere($dbx.hashExp({ status: "public" }))
.andWhere($dbx.like("name", "john"))
.orWhere($dbx.and(
$dbx.hashExp({
role:     "manager",
fullTime: true,
$dbx.exp("experience > {:exp}", { exp: 10 })
...  The following dbx.Expression methods are available:
parameters to the expression.
$dbx.exp("status = 'public'")
$dbx.exp("total > {:min} AND total &lt; {:max}", { min: 10, max: 30 })
-$dbx.hashExp(pairs)
Generates a hash expression from a map whose keys are DB column names which need to be filtered according
to the corresponding values.
// slug = "example" AND active IS TRUE AND tags in ("tag1", "tag2", "tag3") AND parent IS NULL
$dbx.hashExp({
slug:   "example",
active: true,
tags:   ["tag1", "tag2", "tag3"],
parent: null,
-$dbx.not(exp)
Negates a single expression by wrapping it with NOT().
// NOT(status = 1)
$dbx.not($dbx.exp("status = 1"))
-$dbx.and(...exps)
Creates a new expression by concatenating the specified ones with AND.
// (status = 1 AND username like "%john%")
$dbx.and($dbx.exp("status = 1"), $dbx.like("username", "john"))
-$dbx.or(...exps)
Creates a new expression by concatenating the specified ones with OR.
// (status = 1 OR username like "%john%")
$dbx.or($dbx.exp("status = 1"), $dbx.like("username", "john"))
-$dbx.in(col, ...values)
Generates an IN expression for the specified column and the list of allowed values.
// status IN ("public", "reviewed")
$dbx.in("status", "public", "reviewed")
-$dbx.notIn(col, ...values)
Generates an NOT IN expression for the specified column and the list of allowed values.
// status NOT IN ("public", "reviewed")
$dbx.notIn("status", "public", "reviewed")
-$dbx.like(col, ...values)
Generates a LIKE expression for the specified column and the possible strings that the
column should be like. If multiple values are present, the column should be like
all of them.
By default, each value will be surrounded by &quot;%&quot; to enable partial matching. Special
characters like &quot;%&quot;, &quot;\&quot;, &quot;_&quot; will also be properly escaped. You may call
escape(...pairs) and/or match(left, right) to change the default behavior.
// name LIKE "%test1%" AND name LIKE "%test2%"
$dbx.like("name", "test1", "test2")
// name LIKE "test1%"
$dbx.like("name", "test1").match(false, true)
-$dbx.notLike(col, ...values)
Generates a NOT LIKE expression in similar manner as like().
// name NOT LIKE "%test1%" AND name NOT LIKE "%test2%"
$dbx.notLike("name", "test1", "test2")
// name NOT LIKE "test1%"
$dbx.notLike("name", "test1").match(false, true)
-$dbx.orLike(col, ...values)
This is similar to like() except that the column must be one of the provided values, aka.
multiple values are concatenated with OR instead of AND.
// name LIKE "%test1%" OR name LIKE "%test2%"
$dbx.orLike("name", "test1", "test2")
// name LIKE "test1%" OR name LIKE "test2%"
$dbx.orLike("name", "test1", "test2").match(false, true)
-$dbx.orNotLike(col, ...values)
This is similar to notLike() except that the column must not be one of the provided
values, aka. multiple values are concatenated with OR instead of AND.
// name NOT LIKE "%test1%" OR name NOT LIKE "%test2%"
$dbx.orNotLike("name", "test1", "test2")
// name NOT LIKE "test1%" OR name NOT LIKE "test2%"
$dbx.orNotLike("name", "test1", "test2").match(false, true)
-$dbx.exists(exp)
Prefix with EXISTS the specified expression (usually a subquery).
// EXISTS (SELECT 1 FROM users WHERE status = 'active')
$dbx.exists(dbx.exp("SELECT 1 FROM users WHERE status = 'active'"))
-$dbx.notExists(exp)
Prefix with NOT EXISTS the specified expression (usually a subquery).
// NOT EXISTS (SELECT 1 FROM users WHERE status = 'active')
$dbx.notExists(dbx.exp("SELECT 1 FROM users WHERE status = 'active'"))
-$dbx.between(col, from, to)
Generates a BETWEEN expression with the specified range.
// age BETWEEN 3 and 99
$dbx.between("age", 3, 99)
-$dbx.notBetween(col, from, to)
Generates a NOT BETWEEN expression with the specified range.
// age NOT BETWEEN 3 and 99
$dbx.notBetween("age", 3, 99)
##### orderBy(), andOrderBy()
The orderBy(...cols) specifies the ORDER BY clause of the query.
A column name can contain &quot;ASC&quot; or &quot;DESC&quot; to indicate its ordering direction.
You can also use andOrderBy(...cols) to append additional columns to an existing
ORDER BY clause.
$app.db()
.select("users.*")
.from("users")
.orderBy("created ASC", "updated DESC")
.andOrderBy("title ASC")
...  ##### groupBy(), andGroupBy()
The groupBy(...cols) specifies the GROUP BY clause of the query.
You can also use andGroupBy(...cols) to append additional columns to an existing
GROUP BY clause.
$app.db()
.select("users.*")
.from("users")
.groupBy("department", "level")
...  ##### having(), andHaving(), orHaving()
The having(exp) specifies the HAVING clause of the query.
Similarly to
where(exp), it accept a single dbx.Expression (see all available expressions
listed above).
You can also use andHaving(exp) or orHaving(exp) to append additional one or
more conditions to an existing HAVING clause.
$app.db()
.select("users.*")
.from("users")
.groupBy("department", "level")
.having($dbx.exp("sum(level) > {:sum}", { sum: 10 }))
...  ##### limit()
The limit(number) method specifies the LIMIT clause of the query.
$app.db()
.select("users.*")
.from("users")
.limit(30)
...  ##### offset()
The offset(number) method specifies the OFFSET clause of the query. Usually used
together with limit(number).
$app.db()
.select("users.*")
.from("users")
.offset(5)
.limit(30)
...  ### Transaction
To execute multiple queries in a transaction you can use
$app.runInTransaction(fn)
The DB operations are persisted only if the transaction completes without throwing an error.
It is safe to nest runInTransaction calls as long as you use the callback&#39;s
txApp argument.
Inside the transaction function always use its txApp argument and not the original
$app instance because we allow only a single writer/transaction at a time and it could
result in a deadlock.
To avoid performance issues, try to minimize slow/long running tasks such as sending emails,
connecting to external services, etc. as part of the transaction.
$app.runInTransaction((txApp) => {
// update a record
const record = txApp.findRecordById("articles", "RECORD_ID")
record.set("status", "active")
txApp.save(record)
txApp.db().newQuery("DELETE FROM articles WHERE status = 'pending'").execute()

## 30.Extend with JavaScript - Record operations
# Extend with JavaScript - Record operations
Record operations The most common task when extending PocketBase probably would be querying and working with your collection
records.
You could find detailed documentation about all the supported Record model methods in
core.Record
type interface but below are some examples with the most common ones.
### Set field value
// sets the value of a single record field
// (field type specific modifiers are also supported)
record.set("title", "example")
record.set("users+", "6jyr1y02438et52") // append to existing value
// populates a record from a data map
// (calls set() for each entry of the map)
record.load(data)  ### Get field value
// retrieve a single record field value
// (field specific modifiers are also supported)
record.get("someField")            // -> any (without cast)
record.getBool("someField")        // -> cast to bool
record.getString("someField")      // -> cast to string
record.getInt("someField")         // -> cast to int
record.getFloat("someField")       // -> cast to float64
record.getDateTime("someField")    // -> cast to types.DateTime
record.getStringSlice("someField") // -> cast to []string
// retrieve the new uploaded files
// (e.g. for inspecting and modifying the file(s) before save)
record.getUnsavedFiles("someFileField")
// unmarshal a single json field value into the provided result
let result = new DynamicModel({ ... })
record.unmarshalJSONField("someJsonField", result)
// retrieve a single or multiple expanded data
record.expandedOne("author")     // -> as null|Record
record.expandedAll("categories") // -> as []Record
// export all the public safe record fields in a plain object
record.publicExport()  ### Auth accessors
record.isSuperuser() // alias for record.collection().name == "_superusers"
record.email()         // alias for record.get("email")
record.setEmail(email) // alias for record.set("email", email)
record.verified()         // alias for record.get("verified")
record.setVerified(false) // alias for record.set("verified", false)
record.tokenKey()        // alias for record.get("tokenKey")
record.setTokenKey(key)  // alias for record.set("tokenKey", key)
record.refreshTokenKey() // alias for record.set("tokenKey:autogenerate", "")
record.validatePassword(pass)
record.setPassword(pass)   // alias for record.set("password", pass)
record.setRandomPassword() // sets cryptographically random 30 characters string as password  ### Copies
// returns a shallow copy of the current record model populated
// with its ORIGINAL db data state and everything else reset to the defaults
// (usually used for comparing old and new field values)
record.original()
// returns a shallow copy of the current record model populated
// with its LATEST data state and everything else reset to the defaults
// (aka. no expand, no custom fields and with default visibility flags)
record.fresh()
// returns a shallow copy of the current record model populated
// with its ALL collection and custom fields data, expand and visibility flags
record.clone()  ### Hide/Unhide fields
Collection fields can be marked as &quot;Hidden&quot; from the Dashboard to prevent regular user access to the field
values.
Record models provide an option to further control the fields serialization visibility in addition to the
&quot;Hidden&quot; fields option using the
record.hide(fieldNames...)
and
record.unhide(fieldNames...)
methods.
Often the hide/unhide methods are used in combination with the onRecordEnrich hook
invoked on every record enriching (list, view, create, update, realtime change, etc.). For example:
onRecordEnrich((e) => {
// dynamically show/hide a record field depending on whether the current
// authenticated user has a certain "role" (or any other field constraint)
if (
!e.requestInfo.auth ||
(!e.requestInfo.auth.isSuperuser() &amp;&amp; e.requestInfo.auth.get("role") != "staff")
) {
e.record.hide("someStaffOnlyField")
}, "articles")   For custom fields, not part of the record collection schema, it is required to call explicitly
record.withCustomData(true) to allow them in the public serialization.
### Fetch records
##### Fetch single record
All single record retrieval methods throw an error if no record is found.
// retrieve a single "articles" record by its id
let record = $app.findRecordById("articles", "RECORD_ID")
// retrieve a single "articles" record by a single key-value pair
let record = $app.findFirstRecordByData("articles", "slug", "test")
// retrieve a single "articles" record by a string filter expression
let record = $app.findFirstRecordByFilter(
"articles",
"status = 'public' &amp;&amp; category = {:category}",
{ "category": "news" },
)  ##### Fetch multiple records
All multiple records retrieval methods return an empty array if no records are found.
// retrieve multiple "articles" records by their ids
let records = $app.findRecordsByIds("articles", ["RECORD_ID1", "RECORD_ID2"])
// retrieve the total number of "articles" records in a collection with optional dbx expressions
let totalPending = $app.countRecords("articles", $dbx.hashExp({"status": "pending"}))
// retrieve multiple "articles" records with optional dbx expressions
let records = $app.findAllRecords("articles",
$dbx.exp("LOWER(username) = {:username}", {"username": "John.Doe"}),
$dbx.hashExp({"status": "pending"}),
// retrieve multiple paginated "articles" records by a string filter expression
let records = $app.findRecordsByFilter(
"articles",                                    // collection
"status = 'public' &amp;&amp; category = {:category}", // filter
"-published",                                   // sort
10,                                            // limit
0,                                             // offset
{ "category": "news" },                        // optional filter params
)  ##### Fetch auth records
// retrieve a single auth record by its email
// retrieve a single auth record by JWT
// (you could also specify an optional list of accepted token types)
let user = $app.findAuthRecordByToken("YOUR_TOKEN", "auth")  ##### Custom record query
In addition to the above query helpers, you can also create custom Record queries using
$app.recordQuery(collection)
method. It returns a SELECT DB builder that can be used with the same methods described in the
Database guide.
function findTopArticle() {
let record = new Record();
$app.recordQuery("articles")
.andWhere($dbx.hashExp({ "status": "active" }))
.orderBy("rank ASC")
.limit(1)
.one(record)
return record
let article = findTopArticle()  For retrieving multiple Record models with the all() executor, you can use
arrayOf(new Record)
// the below is identical to
// $app.findRecordsByFilter("articles", "status = 'active'", '-published', 10)
// but allows more advanced use cases and filtering (aggregations, subqueries, etc.)
function findLatestArticles() {
let records = arrayOf(new Record);
$app.recordQuery("articles")
.andWhere($dbx.hashExp({ "status": "active" }))
.orderBy("published DESC")
.limit(10)
.all(records)
return records
let articles = findLatestArticles()  ### Create new record
##### Create new record programmatically
let collection = $app.findCollectionByNameOrId("articles")
let record = new Record(collection)
record.set("active", true)
// field type specific modifiers can also be used
record.set("slug:autogenerate", "post-")
// new files must be one or a slice of filesystem.File values
// note1: see all factories in /jsvm/modules/_filesystem.html
// note2: for reading files from a request event you can also use e.findUploadedFiles("fileKey")
let f1 = $filesystem.fileFromPath("/local/path/to/file1.txt")
let f2 = $filesystem.fileFromBytes("test content", "file2.txt")
record.set("documents", [f1, f2, f3])
// validate and persist
// (use saveNoValidate to skip fields validation)
$app.save(record);  ##### Intercept create request
onRecordCreateRequest((e) => {
// ignore for superusers
if (e.hasSuperuserAuth()) {
// overwrite the submitted "status" field value
e.record.set("status", "pending")
// or you can also prevent the create event by returning an error
let status = e.record.get("status")
if (
status != "pending" &amp;&amp;
// guest or not an editor
(!e.auth || e.auth.get("role") != "editor")
) {
throw new BadRequestError("Only editors can set a status different from pending")
}, "articles")  ### Update existing record
##### Update existing record programmatically
let record = $app.findRecordById("articles", "RECORD_ID")
// delete existing record files by specifying their file names
record.set("documents-", ["file1_abc123.txt", "file3_abc123.txt"])
// append one or more new files to the already uploaded list
// note1: see all factories in /jsvm/modules/_filesystem.html
// note2: for reading files from a request event you can also use e.findUploadedFiles("fileKey")
let f1 = $filesystem.fileFromPath("/local/path/to/file1.txt")
let f2 = $filesystem.fileFromBytes("test content", "file2.txt")
record.set("documents+", [f1, f2, f3])
// validate and persist
// (use saveNoValidate to skip fields validation)
$app.save(record);  ##### Intercept update request
onRecordUpdateRequest((e) => {
// ignore for superusers
if (e.hasSuperuserAuth()) {
// overwrite the submitted "status" field value
e.record.set("status", "pending")
// or you can also prevent the update event by returning an error
let status = e.record.get("status")
if (
status != "pending" &amp;&amp;
// guest or not an editor
(!e.auth || e.auth.get("role") != "editor")
) {
throw new BadRequestError("Only editors can set a status different from pending")
}, "articles")  ### Delete record
let record = $app.findRecordById("articles", "RECORD_ID")
$app.delete(record)  ### Transaction
To execute multiple queries in a transaction you can use
$app.runInTransaction(fn)
The DB operations are persisted only if the transaction completes without throwing an error.
It is safe to nest runInTransaction calls as long as you use the callback&#39;s
txApp argument.
Inside the transaction function always use its txApp argument and not the original
$app instance because we allow only a single writer/transaction at a time and it could
result in a deadlock.
To avoid performance issues, try to minimize slow/long running tasks such as sending emails,
connecting to external services, etc. as part of the transaction.
let titles = ["title1", "title2", "title3"]
let collection = $app.findCollectionByNameOrId("articles")
$app.runInTransaction((txApp) => {
// create new record for each title
for (let title of titles) {
let record = new Record(collection)
record.set("title", title)
txApp.save(record)
})  ### Programmatically expanding relations
To expand record relations programmatically you can use
$app.expandRecord(record, expands, customFetchFunc)
for single or
$app.expandRecords(records, expands, customFetchFunc)
for multiple records.
Once loaded, you can access the expanded relations via
record.expandedOne(relName)
record.expandedAll(relName) methods.
For example:
let record = $app.findFirstRecordByData("articles", "slug", "lorem-ipsum")
// expand the "author" and "categories" relations
$app.expandRecord(record, ["author", "categories"], null)
// print the expanded records
console.log(record.expandedOne("author"))
console.log(record.expandedAll("categories"))  ### Check if record can be accessed
To check whether a custom client request or user can access a single record, you can use the
$app.canAccessRecord(record, requestInfo, rule)
method.
Below is an example of creating a custom route to retrieve a single article and checking if the request
satisfy the View API rule of the record collection:
routerAdd("GET", "/articles/{slug}", (e) => {
let slug = e.request.pathValue("slug")
let record = e.app.findFirstRecordByData("articles", "slug", slug)
let canAccess = e.app.canAccessRecord(record, e.requestInfo(), record.collection().viewRule)
if (!canAccess) {
throw new ForbiddenError()
return e.json(200, record)
})  ### Generating and validating tokens
PocketBase Web APIs are fully stateless (aka. there are no sessions in the traditional sense) and an auth
record is considered authenticated if the submitted request contains a valid
Authorization: TOKEN
header
(see also Builtin auth middlewares and
Retrieving the current auth state from a route
If you want to issue and verify manually a record JWT (auth, verification, password reset, etc.), you
could do that using the record token type specific methods:
let token = record.newAuthToken()
let token = record.newVerificationToken()
let token = record.newPasswordResetToken()
let token = record.newEmailChangeToken(newEmail)
let token = record.newFileToken() // for protected files
let token = record.newStaticAuthToken(optCustomDuration) // nonrenewable auth token  Each token type has its own secret and the token duration is managed via its type related collection auth
option (the only exception is newStaticAuthToken).
To validate a record token you can use the
$app.findAuthRecordByToken
method. The token related auth record is returned only if the token is not expired and its signature is valid.
Here is an example how to validate an auth token:
`let record = $app.findAuthRecordByToken("YOUR_TOKEN", "auth")`

## 31.Extend with JavaScript - Collection operations
# Extend with JavaScript - Collection operations
Collection operations Collections are usually managed via the Dashboard interface, but there are some situations where you may
want to create or edit a collection programmatically (usually as part of a
DB migration). You can find all available Collection related operations
and methods in
$app
and
Collection
, but below are listed some of the most common ones:
### Fetch collections
##### Fetch single collection
All single collection retrieval methods throw an error if no collection is found.
`let collection = $app.findCollectionByNameOrId("example")`  ##### Fetch multiple collections
All multiple collections retrieval methods return an empty array if no collections are found.
let allCollections = $app.findAllCollections(/* optional types */)
// only specific types
let authAndViewCollections = $app.findAllCollections("auth", "view")  ##### Custom collection query
In addition to the above query helpers, you can also create custom Collection queries using
$app.collectionQuery()
method. It returns a SELECT DB builder that can be used with the same methods described in the
Database guide.
let collections = arrayOf(new Collection)
$app.collectionQuery().
andWhere($dbx.hashExp({"viewRule": null})).
orderBy("created DESC").
all(collections)  ### Field definitions
All collection fields (with exception of the JSONField) are non-nullable and
use a zero-default for their respective type as fallback value when missing.
-new BoolField({ ... })
-new NumberField({ ... })
-new TextField({ ... })
-new EmailField({ ... })
-new URLField({ ... })
-new EditorField({ ... })
-new DateField({ ... })
-new AutodateField({ ... })
-new SelectField({ ... })
-new FileField({ ... })
-new RelationField({ ... })
-new JSONField({ ... })
-new GeoPointField({ ... })
### Create new collection
// missing default options, system fields like id, email, etc. are initialized automatically
// and will be merged with the provided configuration
let collection = new Collection({
type:       "base", // base | auth | view
name:       "example",
listRule:   null,
viewRule:   "@request.auth.id != ''",
createRule: "",
updateRule: "@request.auth.id != ''",
deleteRule: null,
fields: [
name:     "title",
type:     "text",
required: true,
max: 10,
name:          "user",
type:          "relation",
required:      true,
maxSelect:     1,
collectionId:  "ae40239d2bc4477",
cascadeDelete: true,
indexes: [
"CREATE UNIQUE INDEX idx_user ON example (user)"
// validate and persist
// (use saveNoValidate to skip fields validation)
$app.save(collection)  ### Update existing collection
let collection = $app.findCollectionByNameOrId("example")
// change the collection name
collection.name = "example_update"
// add new editor field
collection.fields.add(new EditorField({
name:     "description",
required: true,
// change existing field
// (returns a pointer and direct modifications are allowed without the need of reinsert)
let titleField = collection.fields.getByName("title")
titleField.min = 10
// or: collection.indexes.push("CREATE INDEX idx_example_title ON example (title)")
collection.addIndex("idx_example_title", false, "title", "")
// validate and persist
// (use saveNoValidate to skip fields validation)
$app.save(collection)  ### Delete collection
let collection = $app.findCollectionByNameOrId("example")
$app.delete(collection)

## 32.Extend with JavaScript - Migrations
# Extend with JavaScript - Migrations
Migrations PocketBase comes with a builtin DB and data migration utility, allowing you to version your DB structure,
create collections programmatically, initialize default settings and/or run anything that needs to be
executed only once.
The user defined migrations are located in pb_migrations directory (it can be changed using
the
--migrationsDir flag) and each unapplied migration inside it will be executed automatically
in a transaction on serve (or on migrate up).
The generated migrations are safe to be committed to version control and can be shared with your other
team members.
### Automigrate
The prebuilt executable has the --automigrate flag enabled by default, meaning that every collection
configuration change from the Dashboard (or Web API) will generate the related migration file automatically
for you.
### Creating migrations
To create a new blank migration you can run migrate create.
`[root@dev app]$ ./pocketbase migrate create "your_new_migration"`   // pb_migrations/1687801097_your_new_migration.js
migrate((app) => {
// add up queries...
}, (app) => {
// add down queries...
})  New migrations are applied automatically on serve.
Optionally, you could apply new migrations manually by running migrate up.
To revert the last applied migration(s), you could run migrate down [number].
When manually applying or reverting migrations, the serve process needs to be restarted so
that it can refresh its cached collections state.
##### Migration file
Each migration file should have a single migrate(upFunc, downFunc) call.
In the migration file, you are expected to write your &quot;upgrade&quot; code in the upFunc callback.
The downFunc is optional and it should contain the &quot;downgrade&quot; operations to revert the
changes made by the upFunc.
Both callbacks accept a transactional app instance.
### Collections snapshot
The migrate collections command generates a full snapshot of your current collections
configuration without having to type it manually. Similar to the migrate create command, this
will generate a new migration file in the
pb_migrations directory.
`[root@dev app]$ ./pocketbase migrate collections`  By default the collections snapshot is imported in extend mode, meaning that collections and
fields that don&#39;t exist in the snapshot are preserved. If you want the snapshot to delete
missing collections and fields, you can edit the generated file and change the last argument of
importCollections
to true.
### Migrations history
All applied migration filenames are stored in the internal _migrations table.
During local development often you might end up making various collection changes to test different approaches.
When --automigrate is enabled (which is the default) this could lead in a migration
history with unnecessary intermediate steps that may not be wanted in the final migration history.
To avoid the clutter and to prevent applying the intermediate steps in production, you can remove (or
squash) the unnecessary migration files manually and then update the local migrations history by running:
`[root@dev app]$ ./pocketbase migrate history-sync`  The above command will remove any entry from the _migrations table that doesn&#39;t have a related
migration file associated with it.
// pb_migrations/1687801090_set_pending_status.js
migrate((app) => {
app.db().newQuery("UPDATE articles SET status = 'pending' WHERE status = ''").execute()
})  ##### Initialize default application settings
// pb_migrations/1687801090_initial_settings.js
migrate((app) => {
let settings = app.settings()
// for all available settings fields you could check
// /jsvm/interfaces/core.Settings.html
settings.meta.appName = "test"
settings.logs.maxDays = 2
settings.logs.logAuthId = true
settings.logs.logIP = false
app.save(settings)
})  ##### Creating initial superuser
For all supported record methods, you can refer to
Record operations
// pb_migrations/1687801090_initial_superuser.js
migrate((app) => {
let superusers = app.findCollectionByNameOrId("_superusers")
let record = new Record(superusers)
// note: the values can be eventually loaded via $os.getenv(key)
// or from a special local config file
record.set("password", "1234567890")
app.save(record)
}, (app) => { // optional revert operation
try {
app.delete(record)
} catch {
// silent errors (probably already deleted)
})  ##### Creating collection programmatically
For all supported collection methods, you can refer to
Collection operations
// migrations/1687801090_create_clients_collection.js
migrate((app) => {
// missing default options, system fields like id, email, etc. are initialized automatically
// and will be merged with the provided configuration
let collection = new Collection({
type:     "auth",
name:     "clients",
listRule: "id = @request.auth.id",
viewRule: "id = @request.auth.id",
fields: [
type:     "text",
name:     "company",
required: true,
max:      100,
name:        "url",
type:        "url",
presentable: true,
passwordAuth: {
enabled: false,
otp: {
enabled: true,
indexes: [
"CREATE INDEX idx_clients_company ON clients (company)"
app.save(collection)
}, (app) => {
let collection = app.findCollectionByNameOrId("clients")
app.delete(collection)

## 33.Extend with JavaScript - Jobs scheduling
# Extend with JavaScript - Jobs scheduling
Jobs scheduling If you have tasks that need to be performed periodically, you could set up crontab-like jobs with
cronAdd(id, expr, handler).
Each scheduled job runs in its own goroutine as part of the serve command process and must have:
-id - identifier for the scheduled job; could be used to replace or remove an existing
job
-cron expression - e.g. 0 0 * * * (
supports numeric list, steps, ranges or
macros )
-handler - the function that will be executed every time when the job runs
Here is an example:
// prints "Hello!" every 2 minutes
cronAdd("hello", "*/2 * * * *", () => {
console.log("Hello!")
})  To remove a single registered cron job you can call cronRemove(id).
All registered app level cron jobs can be also previewed and triggered from the
Dashboard > Settings > Crons section.

## 34.Extend with JavaScript - Sending emails
# Extend with JavaScript - Sending emails
Sending emails PocketBase provides a simple abstraction for sending emails via the
$app.newMailClient() helper.
Depending on your configured mail settings (Dashboard &gt; Settings &gt; Mail settings) it will use the
sendmail command or a SMTP client.
### Send custom email
You can send your own custom emails from everywhere within the app (hooks, middlewares, routes, etc.) by
using $app.newMailClient().send(message). Here is an example of sending a custom email after
user registration:
onRecordCreateRequest((e) => {
const message = new MailerMessage({
from: {
address: e.app.settings().meta.senderAddress,
name:    e.app.settings().meta.senderName,
to:      [{address: e.record.email()}],
subject: "YOUR_SUBJECT...",
html:    "YOUR_HTML_BODY...",
// bcc, cc and custom headers are also supported...
e.app.newMailClient().send(message)
}, "users")  ### Overwrite system emails
If you want to overwrite the default system emails for forgotten password, verification, etc., you can
adjust the default templates available from the
Dashboard &gt; Collections &gt; Edit collection &gt; Options
Alternatively, you can also apply individual changes by binding to one of the
mailer hooks. Here is an example of appending a Record
field value to the subject using the onMailerRecordPasswordResetSend hook:
onMailerRecordPasswordResetSend((e) => {
// modify the subject
e.message.subject += (" " + e.record.get("name"))

## 35.Extend with JavaScript - Rendering templates
Response 200:
{{template "placeholderName" .}}
Response 200:
{{block "placeholderName" .}}default...{{end}}
Response 200:
{{define "placeholderName"}}custom...{{end}}
# Extend with JavaScript - Rendering templates
Rendering templates  ### Overview
A common task when creating custom routes or emails is the need of generating HTML output. To assist with
this, PocketBase provides the global $template helper for parsing and rendering HTML templates.
const html = $template.loadFiles(
`${__hooks}/views/base.html`,
`${__hooks}/views/partial1.html`,
`${__hooks}/views/partial2.html`,
).render(data)  The general flow when working with composed and nested templates is that you create &quot;base&quot; template(s)
The dot object (.) in the above represents the data passed to the templates
via the render(data) method.
By default the templates apply contextual (HTML, JS, CSS, URI) auto escaping so the generated template
For more information about the template syntax please refer to the
html/template
and
text/template
package godocs.
Another great resource is also the Hashicorp&#39;s
Learn Go Template Syntax
tutorial.
### Example HTML page with layout
Consider the following app directory structure:
myapp/
pb_hooks/
views/
layout.html
hello.html
main.pb.js
pocketbase  We define the content for layout.html as:
&lt;!DOCTYPE html>
&lt;html lang="en">
&lt;head>
&lt;title>{{block "title" .}}Default app title{{end}}&lt;/title>
&lt;/head>
&lt;body>
Header...
{{block "body" .}}
Default app body...
{{end}}
&lt;/body>
&lt;/html>  We define the content for hello.html as:
{{define "title"}}
Page 1
{{end}}
{{define "body"}}
&lt;p>Hello from {{.name}}&lt;/p>
{{end}}  Then to output the final page, we&#39;ll register a custom /hello/:name route:
routerAdd("get", "/hello/{name}", (e) => {
const name = e.request.pathValue("name")
const html = $template.loadFiles(
`${__hooks}/views/layout.html`,
`${__hooks}/views/hello.html`,
).render({
"name": name,
return e.html(200, html)

## 36.Extend with JavaScript - Console commands
# Extend with JavaScript - Console commands
Console commands You can register custom console commands using
app.rootCmd.addCommand(cmd), where cmd is a
Command instance.
Here is an example:
$app.rootCmd.addCommand(new Command({
use: "hello",
run: (cmd, args) => {
console.log("Hello world!")
}))  To run the command you can execute:
`./pocketbase hello`   Keep in mind that the console commands execute in their own separate app process and run
independently from the main serve command (aka. hook and realtime events between different
processes are not shared with one another).

## 37.Extend with JavaScript - Realtime messaging
# Extend with JavaScript - Realtime messaging
Realtime messaging By default PocketBase sends realtime events only for Record create/update/delete operations (and for the OAuth2 auth redirect), but you are free to send custom realtime messages to the connected clients via the
$app.subscriptionsBroker() instance.
$app.subscriptionsBroker().clients()
returns all connected
subscriptions.Client
indexed by their unique connection id.
The current auth record associated with a client could be accessed through
client.get(&quot;auth&quot;)
Note that a single authenticated user could have more than one active realtime connection (aka.
multiple clients). This could happen for example when opening the same app in different tabs,
browsers, devices, etc.
Below you can find a minimal code sample that sends a JSON payload to all clients subscribed to the
&quot;example&quot; topic:
const message = new SubscriptionMessage({
name: "example",
data: JSON.stringify({ ... }),
// retrieve all clients (clients id indexed map)
const clients = $app.subscriptionsBroker().clients()
for (let clientId in clients) {
if (clients[clientId].hasSubscription("example")) {
clients[clientId].send(message)
}  From the client-side, users can listen to the custom subscription topic by doing something like:
Dart  import PocketBase from 'pocketbase';
const pb = new PocketBase('http://127.0.0.1:8090');
await pb.realtime.subscribe('example', (e) => {
console.log(e)
})  import 'package:pocketbase/pocketbase.dart';
final pb = PocketBase('http://127.0.0.1:8090');
await pb.realtime.subscribe('example', (e) {
print(e)

## 38.Extend with JavaScript - Filesystem
# Extend with JavaScript - Filesystem
Filesystem PocketBase comes with a thin abstraction between the local filesystem and S3.
To configure which one will be used you can adjust the storage settings from
Dashboard &gt; Settings &gt; Files storage section.
The filesystem abstraction can be accessed programmatically via the
$app.newFilesystem()
method.
Below are listed some of the most common operations but you can find more details in the
filesystem.System
interface.
Always make sure to call close() at the end for both the created filesystem instance and
the retrieved file readers to prevent leaking resources.
### Reading files
To retrieve the file content of a single stored file you can use
getReader(key)
Note that file keys often contain a prefix (aka. the &quot;path&quot; to the file). For record
files the full key is
collectionId/recordId/filename.
To retrieve multiple files matching a specific prefix you can use
list(prefix)
The below code shows a minimal example how to retrieve the content of a single record file as string.
// construct the full file key by concatenating the record storage path with the specific filename
let avatarKey = record.baseFilesPath() + "/" + record.get("avatar")
let fsys, reader, content;
try {
// initialize the filesystem
fsys = $app.newFilesystem();
// retrieve a file reader for the avatar key
reader = fsys.getReader(avatarKey)
// copy as plain string
content = toString(reader)
} finally {
reader?.close();
fsys?.close();
}  ### Saving files
There are several methods to save (aka. write/upload) files depending on the available file content
source:
-upload(content, key)
-uploadFile(file, key)
-uploadMultipart(mfh, key)
Most users rarely will have to use the above methods directly because for collection records the file
persistence is handled transparently when saving the record model (it will also perform size and MIME type
validation based on the collection file field options). For example:
let record = $app.findRecordById("articles", "RECORD_ID")
// Other available File factories
// - $filesystem.fileFromBytes(content, name)
// - $filesystem.fileFromURL(url)
// - $filesystem.fileFromMultipart(mfh)
let file = $filesystem.fileFromPath("/local/path/to/file")
// set new file (can be single or array of File values)
// (if the record has an old file it is automatically deleted on successful save)
record.set("yourFileField", file)
$app.save(record)  ### Deleting files
Files can be deleted from the storage filesystem using
delete(key)
because for collection records the file deletion is handled transparently when removing the existing filename
from the record model (this also ensures that the db entry referencing the file is also removed). For example:
let record = $app.findRecordById("articles", "RECORD_ID")
// if you want to "reset" a file field (aka. deleting the associated single or multiple files)
// you can set it to null
record.set("yourFileField", null)
// OR if you just want to remove individual file(s) from a multiple file field you can use the "-" modifier
// (the value could be a single filename string or slice of filename strings)
record.set("yourFileField-", "example_52iWbGinWd.txt")
$app.save(record)

## 39.Extend with JavaScript - Logging
# Extend with JavaScript - Logging
Logging $app.logger() could be used to write any logs into the database so that they can be later
explored from the PocketBase Dashboard &gt; Logs section.
For better performance and to minimize blocking on hot paths, logs are written with debounce and
on batches:
-3 seconds after the last debounced log write
-when the batch threshold is reached (currently 200)
-right before app termination to attempt saving everything from the existing logs queue
### Logger methods
All standard
slog.Logger
methods are available but below is a list with some of the most notable ones. Note that attributes are represented
as key-value pair arguments.
##### debug(message, attrs...)
$app.logger().debug("Debug message!")
$app.logger().debug(
"Debug message with attributes!",
"name", "John Doe",
"id", 123,
)  ##### info(message, attrs...)
$app.logger().info("Info message!")
$app.logger().info(
"Info message with attributes!",
"name", "John Doe",
"id", 123,
)  ##### warn(message, attrs...)
$app.logger().warn("Warning message!")
$app.logger().warn(
"Warning message with attributes!",
"name", "John Doe",
"id", 123,
)  ##### error(message, attrs...)
$app.logger().error("Error message!")
$app.logger().error(
"Error message with attributes!",
"id", 123,
"error", err,
)  ##### with(attrs...)
with(attrs...) creates a new local logger that will &quot;inject&quot; the specified attributes with each
following log.
const l = $app.logger().with("total", 123)
// results in log with data {"total": 123}
l.info("message A")
// results in log with data {"total": 123, "name": "john"}
l.info("message B", "name", "john")  ##### withGroup(name)
withGroup(name) creates a new local logger that wraps all logs attributes under the specified
group name.
const l = $app.logger().withGroup("sub")
// results in log with data {"sub": { "total": 123 }}
l.info("message A", "total", 123)  ### Logs settings
You can control various log settings like logs retention period, minimal log level, request IP logging,
etc. from the logs settings panel:
### Custom log queries
The logs are usually meant to be filtered from the UI but if you want to programmatically retrieve and
filter the stored logs you can make use of the
$app.logQuery() query builder method. For example:
let logs = arrayOf(new DynamicModel({
id:      "",
created: "",
message: "",
level:   0,
data:    {},
// see https://pocketbase.io/docs/js-database/#query-builder
$app.logQuery().
// target only debug and info logs
andWhere($dbx.in("level", -4, 0)).
// the data column is serialized json object and could be anything
andWhere($dbx.exp("json_extract(data, '$.type') = 'request'")).
orderBy("created DESC").
limit(100).
all(logs)  ### Intercepting logs write
If you want to modify the log data before persisting in the database or to forward it to an external
system, then you can listen for changes of the _logs table by attaching to the
base model hooks. For example:
onModelCreate((e) => {
// print log model fields
console.log(e.model.id)
console.log(e.model.created)
console.log(e.model.level)
console.log(e.model.message)
console.log(e.model.data)
}, "_logs")
