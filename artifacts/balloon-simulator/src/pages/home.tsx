import React, { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { format, addHours } from "date-fns";
import { Map as MapIcon, Crosshair, Wind, Navigation, Activity, Clock, Layers, Rocket, Settings2, Download } from "lucide-react";

import { useRunSimulation, useGetPresets, getGetPresetsQueryKey } from "@workspace/api-client-react";
import type { SimulationInput, SimulationResult } from "@workspace/api-client-react";

import { BalloonMap } from "@/components/Map";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";

const formSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  launch_datetime: z.string().min(1, "Launch datetime is required"),
  ascent_rate: z.coerce.number().min(0.5).max(20),
  burst_altitude: z.coerce.number().min(10000).max(45000),
  descent_rate: z.coerce.number().min(1).max(30),
  time_step: z.coerce.number().min(1).max(300).default(60),
});

export default function Home() {
  const [result, setResult] = useState<SimulationResult | null>(null);

  const { data: presets } = useGetPresets({
    query: { queryKey: getGetPresetsQueryKey() }
  });

  const runSim = useRunSimulation();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      latitude: 37.5665,
      longitude: 126.9780,
      launch_datetime: format(addHours(new Date(), 1), "yyyy-MM-dd'T'HH:mm"),
      ascent_rate: 5.0,
      burst_altitude: 30000,
      descent_rate: 6.0,
      time_step: 60,
    },
  });

  const handleRunSimulation = (values: z.infer<typeof formSchema>) => {
    // Format to ISO8601 for the API
    const date = new Date(values.launch_datetime);
    
    runSim.mutate(
      {
        data: {
          ...values,
          launch_datetime: date.toISOString(),
        }
      },
      {
        onSuccess: (data) => {
          setResult(data);
        }
      }
    );
  };

  const loadPreset = (presetId: string) => {
    const preset = presets?.find(p => p.id === presetId);
    if (preset) {
      form.reset({
        ...preset.config,
        launch_datetime: format(new Date(preset.config.launch_datetime), "yyyy-MM-dd'T'HH:mm")
      });
    }
  };

  // Watch lat/lng for map preview
  const currentLat = form.watch("latitude");
  const currentLng = form.watch("longitude");

  return (
    <div className="flex h-screen w-full bg-background text-foreground overflow-hidden font-sans selection:bg-primary/30">
      
      {/* Left Sidebar - Controls & Stats */}
      <div className="w-[480px] min-w-[480px] h-full flex flex-col border-r border-border bg-card/50 backdrop-blur shadow-2xl relative z-10">
        
        {/* Header */}
        <div className="px-6 py-5 border-b border-border bg-card">
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded bg-primary/20 flex items-center justify-center border border-primary/50 text-primary">
              <Rocket className="w-4 h-4" />
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight uppercase text-foreground">Fall Prediction Simulator</h1>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-mono">Flight Planning Tool v1.0</p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-8">
            
            {/* Form Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                  <Settings2 className="w-3.5 h-3.5" />
                  Parameters
                </h2>
                
                {presets && presets.length > 0 && (
                  <Select onValueChange={loadPreset}>
                    <SelectTrigger className="h-7 w-[140px] text-xs font-mono bg-muted/50 border-border">
                      <SelectValue placeholder="Load Preset..." />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map(p => (
                        <SelectItem key={p.id} value={p.id} className="text-xs font-mono">{p.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              <Form {...form}>
                <form onSubmit={form.handleSubmit(handleRunSimulation)} className="space-y-5">
                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="latitude"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">LATITUDE</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.0001" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="longitude"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">LONGITUDE</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.0001" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="launch_datetime"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-xs font-mono text-muted-foreground">LAUNCH DATETIME (LOCAL)</FormLabel>
                        <FormControl>
                          <Input type="datetime-local" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                        </FormControl>
                      </FormItem>
                    )}
                  />

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="ascent_rate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">ASCENT (m/s)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="descent_rate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">DESCENT (m/s)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <FormField
                      control={form.control}
                      name="burst_altitude"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">BURST ALT (m)</FormLabel>
                          <FormControl>
                            <Input type="number" step="100" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="time_step"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs font-mono text-muted-foreground">TIME STEP (s)</FormLabel>
                          <FormControl>
                            <Input type="number" step="1" className="font-mono text-sm h-9 bg-muted/30" {...field} />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  </div>

                  <Button 
                    type="submit" 
                    className="w-full h-10 font-bold tracking-wider uppercase text-xs" 
                    disabled={runSim.isPending}
                  >
                    {runSim.isPending ? "Calculating Trajectory..." : "Run Simulation"}
                  </Button>
                </form>
              </Form>
            </div>

            <Separator className="bg-border/50" />

            {/* Results Section */}
            {result && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-bold uppercase tracking-wider text-primary flex items-center gap-2">
                    <Activity className="w-3.5 h-3.5" />
                    Flight Telemetry
                  </h2>
                  <Badge variant="outline" className="font-mono text-[10px] bg-primary/10 text-primary border-primary/20">
                    T+{Math.floor(result.stats.total_duration_seconds / 60)}m
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <StatCard 
                    label="Flight Time" 
                    value={`${Math.floor(result.stats.total_duration_seconds / 3600)}h ${Math.floor((result.stats.total_duration_seconds % 3600) / 60)}m`}
                    icon={<Clock className="w-3.5 h-3.5 text-muted-foreground" />}
                  />
                  <StatCard 
                    label="Max Altitude" 
                    value={`${(result.stats.max_altitude / 1000).toFixed(1)} km`}
                    icon={<Layers className="w-3.5 h-3.5 text-muted-foreground" />}
                  />
                  <StatCard 
                    label="Peak Wind" 
                    value={`${result.stats.max_wind_speed.toFixed(1)} m/s`}
                    icon={<Wind className="w-3.5 h-3.5 text-muted-foreground" />}
                  />
                  <StatCard 
                    label="Horiz. Drift" 
                    value={`${result.stats.horizontal_drift_km.toFixed(1)} km`}
                    icon={<Navigation className="w-3.5 h-3.5 text-muted-foreground" />}
                  />
                  <StatCard 
                    label="Ascent Time" 
                    value={`${Math.floor(result.stats.ascent_duration_seconds / 60)}m`}
                    className="bg-blue-500/5 border-blue-500/10"
                  />
                  <StatCard 
                    label="Descent Time" 
                    value={`${Math.floor(result.stats.descent_duration_seconds / 60)}m`}
                    className="bg-orange-500/5 border-orange-500/10"
                  />
                </div>

                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem value="trajectory" className="border-border">
                    <AccordionTrigger className="text-xs font-mono text-muted-foreground hover:text-foreground py-3">
                      VIEW FULL TRAJECTORY LOG
                    </AccordionTrigger>
                    <AccordionContent>
                      <div className="bg-black/40 border border-border rounded-md overflow-hidden">
                        <table className="w-full text-[10px] font-mono text-left">
                          <thead className="bg-muted/50 text-muted-foreground border-b border-border">
                            <tr>
                              <th className="px-3 py-2 font-medium">Time (T+)</th>
                              <th className="px-3 py-2 font-medium">Alt (m)</th>
                              <th className="px-3 py-2 font-medium">Phase</th>
                              <th className="px-3 py-2 font-medium">Wind (m/s)</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border/50">
                            {result.trajectory.filter((_, i) => i % 5 === 0 || i === result.trajectory.length - 1).map((pt, i) => {
                              const date = new Date(pt.time);
                              const launchDate = new Date(result.trajectory[0].time);
                              const tPlus = Math.floor((date.getTime() - launchDate.getTime()) / 60000);
                              return (
                                <tr key={i} className="hover:bg-muted/30 transition-colors">
                                  <td className="px-3 py-2 text-muted-foreground">+{tPlus}m</td>
                                  <td className="px-3 py-2 text-foreground">{pt.altitude.toFixed(0)}</td>
                                  <td className="px-3 py-2">
                                    <span className={pt.phase === 'ascent' ? 'text-blue-400' : 'text-orange-400'}>
                                      {pt.phase.toUpperCase()}
                                    </span>
                                  </td>
                                  <td className="px-3 py-2 text-muted-foreground">{pt.wind_speed.toFixed(1)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>

              </div>
            )}
            
          </div>
        </ScrollArea>
      </div>

      {/* Right Side - Interactive Map */}
      <div className="flex-1 relative bg-black">
        <BalloonMap 
          simulationResult={result} 
          launchPos={{ lat: currentLat || 37.5665, lng: currentLng || 126.9780 }} 
        />
        
        {/* Map UI overlays */}
        <div className="absolute bottom-6 right-6 z-[400] flex gap-2">
          {result && (
            <div className="flex gap-4 px-4 py-2 bg-background/90 backdrop-blur border border-border rounded-full shadow-2xl items-center text-xs font-mono font-medium">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-sm bg-[#0ea5e9]"></div>
                <span className="text-muted-foreground">ASCENT</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-sm bg-[#f97316]"></div>
                <span className="text-muted-foreground">DESCENT</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, className = "" }: { label: string, value: string, icon?: React.ReactNode, className?: string }) {
  return (
    <div className={`flex flex-col p-3 rounded-md bg-muted/20 border border-border/50 ${className}`}>
      <div className="flex items-center gap-1.5 mb-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-wider">{label}</span>
      </div>
      <span className="text-sm font-mono font-semibold tracking-tight text-foreground">{value}</span>
    </div>
  );
}
