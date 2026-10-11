#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#ifndef AppVersionInfo
  #define AppVersionInfo "0.0.0.0"
#endif

#ifndef RepoRoot
  #define RepoRoot ".."
#endif

#ifndef SourceDir
  #define SourceDir "..\dist\win"
#endif

#ifndef OutputDir
  #define OutputDir "..\dist\release"
#endif

[Setup]
AppId={{F0BA6FB7-CB7B-4358-839F-CB92DC65E93B}
AppName=inpx-shelf
AppVersion={#AppVersion}
AppPublisher=vvorth
AppPublisherURL=https://github.com/vvorth/inpx-shelf
AppSupportURL=https://github.com/vvorth/inpx-shelf/issues
AppUpdatesURL=https://github.com/vvorth/inpx-shelf/releases/latest
DefaultDirName={localappdata}\Programs\inpx-shelf
DefaultGroupName=inpx-shelf
AllowNoIcons=yes
PrivilegesRequired=lowest
OutputDir={#OutputDir}
OutputBaseFilename=inpx-shelf-{#AppVersion}-win-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#RepoRoot}\client\assets\favicon.ico
LicenseFile={#RepoRoot}\LICENSE.md
UninstallDisplayIcon={app}\inpx-shelf.exe
VersionInfoVersion={#AppVersionInfo}
VersionInfoCompany=vvorth
VersionInfoDescription=inpx-shelf Windows installer
VersionInfoProductName=inpx-shelf
VersionInfoProductVersion={#AppVersionInfo}
VersionInfoProductTextVersion={#AppVersion}

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\inpx-shelf.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\readme.html"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "{#SourceDir}\bin\*"; DestDir: "{app}\bin"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "{#RepoRoot}\LICENSE.md"; DestDir: "{app}"; Flags: ignoreversion

[INI]
Filename: "{app}\inpx-shelf.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://127.0.0.1:12380"
Filename: "{app}\inpx-shelf.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\inpx-shelf.exe"
Filename: "{app}\inpx-shelf.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\inpx-shelf"; Filename: "{app}\inpx-shelf.exe"; Parameters: "--data-dir=""{localappdata}\inpx-shelf"""; WorkingDir: "{app}"
Name: "{group}\Open web interface"; Filename: "{app}\inpx-shelf.url"; WorkingDir: "{app}"
Name: "{group}\README"; Filename: "{app}\readme.html"; WorkingDir: "{app}"; Check: FileExists(ExpandConstant('{app}\readme.html'))
Name: "{group}\Uninstall inpx-shelf"; Filename: "{uninstallexe}"
Name: "{autodesktop}\inpx-shelf"; Filename: "{app}\inpx-shelf.exe"; Parameters: "--data-dir=""{localappdata}\inpx-shelf"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\inpx-shelf.exe"; Parameters: "--data-dir=""{localappdata}\inpx-shelf"""; Description: "{cm:LaunchProgram,inpx-shelf}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\inpx-shelf.url"
