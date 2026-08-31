using System.Text.Json;
using CUE4Parse.Encryption.Aes;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;

const string PD3_AES_KEY = "27DFBADBB537388ACDE27A7C5F3EBC3721AF0AE0A7602D2D7F8A16548F37D394";
const string CB_AES_KEY = "40A34FBE5D5DC4BF94ECDCF042816C7C57AA11FAEE07FDB71E908E97A2F28FA6";

var pakPath = TakeValue(args, "--pak");
var game = TakeValue(args, "--game");
var aesKey = TakeValue(args, "--aes");
var usmapPath = TakeValue(args, "--usmap");

if (pakPath is null || game is not ("pd3" or "cb"))
{
    Console.Error.WriteLine("usage: pakviewer --pak <file> --game <pd3|cb> [--aes <key>] [--usmap <file>]");
    return 2;
}

if (!File.Exists(pakPath))
{
    Console.Error.WriteLine($"pak file not found: {pakPath}");
    return 1;
}

// Both supported games encrypt their content paks; mod paks usually are not, but the
// games' own AES keys are baked in as defaults so --game pd3/cb works without an
// explicit key. A caller-supplied --aes (a user override from Settings) always wins.
var resolvedAes = aesKey ?? (game == "pd3" ? PD3_AES_KEY : game == "cb" ? CB_AES_KEY : null);

// A scratch root keeps DefaultFileProvider from scanning the pak's real directory
// (which would pull in every sibling mod); only the registered pak is mounted.
var tempRoot = Path.Combine(Path.GetTempPath(), "pakviewer-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(tempRoot);

try
{
    // Both supported games run Unreal Engine 4.27. --game is validated up front so the
    // mapping stays explicit when a future game brings a different engine version.
    using var provider = new DefaultFileProvider(tempRoot, SearchOption.TopDirectoryOnly, new VersionContainer(EGame.GAME_UE4_27));
    provider.Initialize();
    provider.RegisterVfs(pakPath);
    if (resolvedAes is not null)
    {
        provider.SubmitKey(new FGuid(), new FAesKey(resolvedAes));
    }
    provider.Mount();
    if (usmapPath is not null)
    {
        provider.MappingsContainer = new FileUsmapTypeMappingsProvider(usmapPath);
    }

    var assets = new List<PakAsset>();
    foreach (var file in provider.Files.Values)
    {
        string? className = null;
        if (file.IsUePackage)
        {
            try
            {
                var pkg = await provider.LoadPackageAsync(file.PathWithoutExtension);
                var exports = pkg.GetExports();
                className = (exports.FirstOrDefault(e => e.Name == file.NameWithoutExtension)
                             ?? exports.FirstOrDefault())?.ExportType;
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"warn: {file.Path}: {e.Message}");
            }
        }
        assets.Add(new PakAsset(file.Path, file.Size, className));
    }

    Console.WriteLine(JsonSerializer.Serialize(assets, new JsonSerializerOptions
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    }));
    return 0;
}
catch (Exception e)
{
    Console.Error.WriteLine(e.Message);
    return 1;
}
finally
{
    try
    {
        Directory.Delete(tempRoot, true);
    }
    catch
    {
        // Scratch cleanup is best-effort; a leftover temp dir is harmless.
    }
}

static string? TakeValue(string[] args, string name)
{
    var index = Array.IndexOf(args, name);
    return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
}

record PakAsset(string Path, long Size, string? Class);
